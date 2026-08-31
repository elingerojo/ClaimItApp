/**
 * backend/src/controllers/eventsController.ts
 *
 * Handlers for event creation, member management, and invitation processing.
 * Implements role cascading and availability calculations.
 */

import { Request, Response } from 'express';
import pool from '../config/db.js';
import { validateEventInput, validateInvitationCode } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import {
  ROLE_HIERARCHY,
  VALID_ROLES,
  calculateEffectiveAvailability,
  determineRoleAfterInvitation,
  generateInvitationCode,
  validateEventDates
} from '@claimitapp/shared';

/**
 * Create a new event with invitation links
 * Automatically generates 4 cryptic invitation codes (one per role)
 */
export const createEvent = async (req: Request, res: Response): Promise<void> => {
  const { title, description, available_from, pickup_deadline } = req.body;
  const ownerUuid = req.body.userUuid || (req as any).userUuid; // Can come from auth context
  const adminCode = (req as any).adminCode || 'system'; // If called via admin endpoint

  // Validate input
  const validation = validateEventInput(req.body);
  if (!validation.valid) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Validate dates
  const dateValidation = validateEventDates(new Date(available_from), new Date(pickup_deadline));
  if (!dateValidation.valid) {
    res.status(400).json({
      error: 'Date validation failed',
      details: [dateValidation.error!],
      timestamp: new Date().toISOString()
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check owner exists
    const ownerResult = await client.query(
      'SELECT uuid, global_role FROM users WHERE uuid = $1',
      [ownerUuid]
    );
    if (ownerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Owner user not found' });
      return;
    }

    // Create event
    const eventResult = await client.query(
      `INSERT INTO events 
       (owner_uuid, title, description, available_from, pickup_deadline)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [ownerUuid, title, description || null, available_from, pickup_deadline]
    );

    const eventId = eventResult.rows[0].id;

    // Add owner as event member with 'familiares' role automatically
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, invited_by, joined_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [eventId, ownerUuid, 'familiares', ownerUuid]
    );

    // Generate 4 cryptic invitation codes (one per role)
    const invitationCodes: Record<string, string> = {};
    for (const role of VALID_ROLES) {
      const code = generateInvitationCode();
      invitationCodes[role] = code;

      await client.query(
        `INSERT INTO event_invitations (event_id, role, code, created_by, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [eventId, role, code, ownerUuid]
      );
    }

    await client.query('COMMIT');

    // Log audit entry
    await logAudit({
      action: 'EVENT_CREATED',
      adminCodeSuffix: maskAdminCode(adminCode),
      itemId: eventId,
      userId: ownerUuid,
      details: {
        title: title,
        available_from: available_from,
        pickup_deadline: pickup_deadline,
        timestamp: new Date().toISOString()
      }
    });

    res.status(201).json({
      success: true,
      event: {
        eventId,
        title,
        message: 'Event created with 4 invitation links generated'
      },
      invitationCodes
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Event creation failed:', error);
    res.status(500).json({
      error: 'Failed to create event',
      timestamp: new Date().toISOString()
    });
  } finally {
    client.release();
  }
};

/**
 * Accept an invitation with role cascading
 * If invitation role has higher privilege than user's current role, upgrade user
 */
export const acceptInvitation = async (req: Request, res: Response): Promise<void> => {
  const { invitationCode, userUuid } = req.body;

  if (!invitationCode || !userUuid) {
    res.status(400).json({ error: 'Missing invitationCode or userUuid' });
    return;
  }

  // Validate invitation code format
  if (!validateInvitationCode(invitationCode)) {
    res.status(400).json({ error: 'Invalid invitation code format' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Validate invitation
    const invResult = await client.query(
      `SELECT ei.role, ei.event_id, e.title, e.owner_uuid
       FROM event_invitations ei
       JOIN events e ON ei.event_id = e.id
       WHERE ei.code = $1 AND ei.is_active = true`,
      [invitationCode]
    );

    if (invResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Invalid or expired invitation code' });
      return;
    }

    const { role: invitationRole, event_id: eventId, title: eventTitle, owner_uuid: ownerUuid } = invResult.rows[0];

    // 2. Get or create user, get current role
    let userResult = await client.query(
      'SELECT uuid, global_role FROM users WHERE uuid = $1',
      [userUuid]
    );

    let currentRole = 'publico';
    if (userResult.rows.length === 0) {
      // Create user if doesn't exist
      await client.query(
        'INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)',
        [userUuid, 'User_' + userUuid.slice(0, 8), 'publico']
      );
    } else {
      currentRole = userResult.rows[0].global_role;
    }

    // 3. Determine if role should cascade
    const newRole = determineRoleAfterInvitation(currentRole, invitationRole);
    const roleCascaded = newRole !== currentRole;

    // 4. Register user in event_members
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, invited_by, joined_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (event_id, user_uuid) DO UPDATE
       SET role = $3, invited_by = $4`,
      [eventId, userUuid, invitationRole, ownerUuid]
    );

    // 5. Update user's global role if cascaded
    if (roleCascaded) {
      await client.query(
        'UPDATE users SET global_role = $1 WHERE uuid = $2',
        [newRole, userUuid]
      );
    }

    // 6. Increment invitation use_count
    await client.query(
      'UPDATE event_invitations SET use_count = use_count + 1 WHERE code = $1',
      [invitationCode]
    );

    await client.query('COMMIT');

    // Log audit entry
    await logAudit({
      action: 'INVITATION_ACCEPTED',
      adminCodeSuffix: 'N/A',
      itemId: eventId,
      userId: userUuid,
      details: {
        eventTitle: eventTitle,
        invitedRole: invitationRole,
        previousRole: currentRole,
        newRole: newRole,
        cascaded: roleCascaded,
        timestamp: new Date().toISOString()
      }
    });

    res.status(200).json({
      success: true,
      message: `Welcome to "${eventTitle}"${roleCascaded ? ` with role ${newRole}` : ''}`,
      eventId,
      role: newRole,
      cascaded: roleCascaded
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Invitation acceptance failed:', error);
    res.status(500).json({
      error: 'Failed to accept invitation',
      timestamp: new Date().toISOString()
    });
  } finally {
    client.release();
  }
};

/**
 * Get event details with user's effective availability
 */
export const getEvent = async (req: Request, res: Response): Promise<void> => {
  const { eventId } = req.params;
  const userUuid = req.query.userUuid as string;

  try {
    const eventResult = await pool.query(
      'SELECT * FROM events WHERE id = $1',
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const event = eventResult.rows[0];

    // If userUuid provided, calculate their effective availability
    let effectiveAvailability = null;
    if (userUuid) {
      try {
        effectiveAvailability = await calculateEffectiveAvailability(userUuid, eventId, pool);
      } catch (error) {
        console.warn('Could not calculate effective availability:', error);
      }
    }

    res.json({
      event,
      effectiveAvailability
    });
  } catch (error) {
    console.error('Failed to fetch event:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

/**
 * Get all events (paginated)
 */
export const listEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const result = await pool.query(
      `SELECT id, owner_uuid, title, description, available_from, pickup_deadline, created_at
       FROM events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      events: result.rows,
      limit,
      offset
    });
  } catch (error) {
    console.error('Failed to list events:', error);
    res.status(500).json({ error: 'Failed to list events' });
  }
};
