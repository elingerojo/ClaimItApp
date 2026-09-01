/**
 * backend/src/controllers/eventsController.ts
 *
 * Handlers for event creation, member management, and invitation processing.
 * Implements role cascading, availability calculations, admin CRUD with date
 * propagation, batch item assignment and share links.
 */

import { Request, Response } from 'express';
import pool from '../config/db.js';
import { validateEventInput, validateInvitationCode } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import {
  getUser,
  upsertUser,
  upsertEvent,
  removeEvent,
  upsertEventMember,
  setItemEvent,
  propagateEventDates,
  detachItemsFromEvent
} from '../cache/appStore.js';
import {
  VALID_ROLES,
  calculateEffectiveAvailability,
  determineRoleAfterInvitation,
  generateInvitationCode,
  validateEventDates
} from '@claimitapp/shared';

/** Which link a user receives to invite one level down the cascade. */
const NEXT_ROLE: Record<string, string | null> = {
  familiares: 'amigos',
  amigos: 'conocidos',
  conocidos: 'publico',
  publico: null
};

/**
 * Create a new event with invitation links
 * Automatically generates 4 cryptic invitation codes (one per role)
 */
export const createEvent = async (req: Request, res: Response): Promise<void> => {
  const {
    title,
    description,
    available_from,
    pickup_deadline,
    published_at,
    familiares_advance_hours,
    amigos_advance_hours,
    conocidos_advance_hours,
    familiares_share_bonus,
    amigos_share_bonus,
    conocidos_share_bonus
  } = req.body;
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
    const ownerResult = await client.query('SELECT uuid, global_role FROM users WHERE uuid = $1', [
      ownerUuid
    ]);
    if (ownerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Owner user not found' });
      return;
    }

    // Create event (persist role advance/share-bonus configuration; fall back to
    // the DB defaults when not provided)
    const eventResult = await client.query(
      `INSERT INTO events 
       (owner_uuid, title, description, available_from, pickup_deadline, published_at,
        familiares_advance_hours, amigos_advance_hours, conocidos_advance_hours,
        familiares_share_bonus, amigos_share_bonus, conocidos_share_bonus)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, created_at`,
      [
        ownerUuid,
        title,
        description || null,
        available_from,
        pickup_deadline,
        published_at || null,
        familiares_advance_hours ?? 72,
        amigos_advance_hours ?? 24,
        conocidos_advance_hours ?? 0,
        familiares_share_bonus ?? 6,
        amigos_share_bonus ?? 4,
        conocidos_share_bonus ?? 2
      ]
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

    // Write-through: keep the RAM store in sync with Neon
    upsertEvent({
      id: eventId,
      available_from,
      published_at: published_at || null,
      status: 'draft',
      familiares_advance_hours: familiares_advance_hours ?? 72,
      amigos_advance_hours: amigos_advance_hours ?? 24,
      conocidos_advance_hours: conocidos_advance_hours ?? 0,
      publico_advance_hours: 0
    });
    upsertEventMember(ownerUuid, { eventId, role: 'familiares', bonusHours: 0, invitedBy: ownerUuid });

    // Log audit entry (no itemId: events are not items and would violate the FK)
    await logAudit({
      action: 'EVENT_CREATED',
      adminCodeSuffix: maskAdminCode(adminCode),
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

    const { role: invitationRole, event_id: eventId, title: eventTitle, owner_uuid: ownerUuid } =
      invResult.rows[0];

    // 2. Get or create user, get current role
    let userResult = await client.query('SELECT uuid, global_role FROM users WHERE uuid = $1', [
      userUuid
    ]);

    let currentRole = 'publico';
    if (userResult.rows.length === 0) {
      // Create user if doesn't exist
      await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
        userUuid,
        'User_' + userUuid.slice(0, 8),
        'publico'
      ]);
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
      await client.query('UPDATE users SET global_role = $1 WHERE uuid = $2', [newRole, userUuid]);
    }

    // 6. Increment invitation use_count
    await client.query('UPDATE event_invitations SET use_count = use_count + 1 WHERE code = $1', [
      invitationCode
    ]);

    await client.query('COMMIT');

    // Write-through: actualizar el rol del usuario en el store (preservando el alias)
    const existingUser = getUser(userUuid);
    upsertUser({
      uuid: userUuid,
      alias: existingUser?.alias ?? 'User_' + userUuid.slice(0, 8),
      global_role: newRole
    });
    upsertEventMember(userUuid, {
      eventId,
      role: invitationRole,
      bonusHours: 0,
      invitedBy: ownerUuid
    });

    // Log audit entry (no itemId: events are not items and would violate the FK)
    await logAudit({
      action: 'INVITATION_ACCEPTED',
      adminCodeSuffix: 'N/A',
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
 * PATCH /api/admin/events/:id
 * Updates an event and propagates date changes to the items that inherit them
 * (items with their own override keep it — inheritance vs override).
 */
export const updateEvent = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const {
    title,
    description,
    available_from,
    pickup_deadline,
    published_at,
    familiares_advance_hours,
    amigos_advance_hours,
    conocidos_advance_hours,
    familiares_share_bonus,
    amigos_share_bonus,
    conocidos_share_bonus
  } = req.body;
  const adminCode = (req as any).adminCode || 'system';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const upd = await client.query(
      `UPDATE events SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         available_from = COALESCE($3, available_from),
         pickup_deadline = COALESCE($4, pickup_deadline),
         published_at = COALESCE($5, published_at),
         familiares_advance_hours = COALESCE($6, familiares_advance_hours),
         amigos_advance_hours = COALESCE($7, amigos_advance_hours),
         conocidos_advance_hours = COALESCE($8, conocidos_advance_hours),
         familiares_share_bonus = COALESCE($9, familiares_share_bonus),
         amigos_share_bonus = COALESCE($10, amigos_share_bonus),
         conocidos_share_bonus = COALESCE($11, conocidos_share_bonus),
         updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        title ?? null,
        description ?? null,
        available_from ?? null,
        pickup_deadline ?? null,
        published_at ?? null,
        familiares_advance_hours ?? null,
        amigos_advance_hours ?? null,
        conocidos_advance_hours ?? null,
        familiares_share_bonus ?? null,
        amigos_share_bonus ?? null,
        conocidos_share_bonus ?? null,
        id
      ]
    );

    // Propagate date changes to inheriting items (single UPDATE per field)
    if (available_from) {
      await client.query(
        'UPDATE items SET available_from = $1 WHERE event_id = $2 AND available_from IS NULL',
        [available_from, id]
      );
    }
    if (published_at) {
      await client.query(
        'UPDATE items SET visible_at = $1 WHERE event_id = $2 AND visible_at IS NULL',
        [published_at, id]
      );
    }

    await client.query('COMMIT');

    // Write-through: sync the event and inherited dates in the RAM store
    const event = upd.rows[0];
    upsertEvent({
      id: event.id,
      available_from: event.available_from,
      published_at: event.published_at,
      status: event.status,
      familiares_advance_hours: event.familiares_advance_hours,
      amigos_advance_hours: event.amigos_advance_hours,
      conocidos_advance_hours: event.conocidos_advance_hours,
      publico_advance_hours: event.publico_advance_hours
    });
    propagateEventDates(id, {
      availableFrom: event.available_from,
      visibleAt: event.published_at
    });

    await logAudit({
      action: 'EVENT_UPDATED',
      adminCodeSuffix: maskAdminCode(adminCode),
      details: { timestamp: new Date().toISOString() }
    });

    res.json({ success: true, event });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Event update failed:', error);
    res.status(500).json({ error: 'Failed to update event' });
  } finally {
    client.release();
  }
};

/**
 * DELETE /api/admin/events/:id
 * Deletes an event; its items keep event_id = NULL (ON DELETE SET NULL) and
 * continue working with their existing behavior.
 */
export const deleteEvent = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const adminCode = (req as any).adminCode || 'system';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const del = await client.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (del.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    // Defensive: detach items explicitly (FK also ON DELETE SET NULL)
    await client.query('UPDATE items SET event_id = NULL WHERE event_id = $1', [id]);

    await client.query('COMMIT');

    // Write-through
    removeEvent(id);
    detachItemsFromEvent(id);

    await logAudit({
      action: 'EVENT_DELETED',
      adminCodeSuffix: maskAdminCode(adminCode),
      details: { timestamp: new Date().toISOString() }
    });

    res.json({ success: true, message: 'Event deleted. Items detached.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Event deletion failed:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  } finally {
    client.release();
  }
};

/**
 * GET /api/admin/events/:id
 * Detail of an event with its items, members grouped by role and invitation links.
 */
export const getEventDetail = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const ev = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    if (ev.rows.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const items = await pool.query(
      `SELECT id, title, status, visibility_level, available_from, visible_at
       FROM items WHERE event_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    const members = await pool.query(
      `SELECT em.user_uuid, u.alias, em.role, em.bonus_hours, em.invited_by, em.joined_at
       FROM event_members em
       JOIN users u ON em.user_uuid = u.uuid
       WHERE em.event_id = $1 ORDER BY em.role, em.joined_at`,
      [id]
    );
    const invites = await pool.query(
      `SELECT role, code, use_count, is_active, created_at
       FROM event_invitations WHERE event_id = $1 ORDER BY role`,
      [id]
    );

    res.json({
      event: ev.rows[0],
      items: items.rows,
      members: members.rows,
      invitations: invites.rows
    });
  } catch (error) {
    console.error('Failed to fetch event detail:', error);
    res.status(500).json({ error: 'Failed to fetch event detail' });
  }
};

/**
 * POST /api/admin/events/:id/items
 * Batch-assign items to an event (array of itemId).
 */
export const assignItems = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { itemIds } = req.body;
  const adminCode = (req as any).adminCode || 'system';

  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    res.status(400).json({ error: 'itemIds must be a non-empty array' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ev = await client.query('SELECT id FROM events WHERE id = $1 FOR UPDATE', [id]);
    if (ev.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    for (const itemId of itemIds) {
      await client.query('UPDATE items SET event_id = $1 WHERE id = $2', [id, itemId]);
    }

    await client.query('COMMIT');

    // Write-through
    for (const itemId of itemIds) {
      setItemEvent(itemId, id);
    }

    await logAudit({
      action: 'EVENT_ITEMS_ASSIGNED',
      adminCodeSuffix: maskAdminCode(adminCode),
      details: { assignedCount: itemIds.length, timestamp: new Date().toISOString() }
    });

    res.json({ success: true, assigned: itemIds.length });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Assign items failed:', error);
    res.status(500).json({ error: 'Failed to assign items to event' });
  } finally {
    client.release();
  }
};

/**
 * GET /api/events/:id/invite/:code
 * Validates an invitation code and returns the event/role/inviter info.
 */
export const validateInvitation = async (req: Request, res: Response): Promise<void> => {
  const { id, code } = req.params;

  try {
    const inv = await pool.query(
      `SELECT ei.role, ei.is_active, e.title, u.alias AS inviter_alias
       FROM event_invitations ei
       JOIN events e ON ei.event_id = e.id
       LEFT JOIN users u ON ei.created_by = u.uuid
       WHERE ei.event_id = $1 AND ei.code = $2`,
      [id, code]
    );

    if (inv.rows.length === 0) {
      res.status(404).json({ error: 'Invalid invitation code' });
      return;
    }
    if (!inv.rows[0].is_active) {
      res.status(403).json({ error: 'Invitation is inactive' });
      return;
    }

    res.json({
      eventId: id,
      eventTitle: inv.rows[0].title,
      role: inv.rows[0].role,
      inviterAlias: inv.rows[0].inviter_alias
    });
  } catch (error) {
    console.error('Invitation validation failed:', error);
    res.status(500).json({ error: 'Failed to validate invitation' });
  }
};

/**
 * GET /api/events/:id/share-link
 * Returns the invitation link for the NEXT role down the cascade based on the
 * user's global role. Public users cannot share (403).
 */
export const getShareLink = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const userUuid = req.query.userUuid as string;

  if (!userUuid) {
    res.status(400).json({ error: 'userUuid is required' });
    return;
  }

  const user = getUser(userUuid);
  const role = user?.global_role || 'publico';
  const nextRole = NEXT_ROLE[role];

  if (!nextRole) {
    res.status(403).json({ error: 'Public users cannot share invitations' });
    return;
  }

  try {
    const inv = await pool.query(
      `SELECT code FROM event_invitations
       WHERE event_id = $1 AND role = $2 AND is_active = true`,
      [id, nextRole]
    );

    if (inv.rows.length === 0) {
      res.status(404).json({ error: 'No shareable link available for this role' });
      return;
    }

    res.json({ eventId: id, role: nextRole, code: inv.rows[0].code });
  } catch (error) {
    console.error('Share link failed:', error);
    res.status(500).json({ error: 'Failed to obtain share link' });
  }
};

/**
 * Get event details with user's effective availability
 */
export const getEvent = async (req: Request, res: Response): Promise<void> => {
  const { eventId } = req.params;
  const userUuid = req.query.userUuid as string;

  try {
    const eventResult = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);

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
