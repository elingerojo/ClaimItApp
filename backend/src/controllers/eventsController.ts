/**
 * backend/src/controllers/eventsController.ts — Eventos v2 (Estrategia temporal v2)
 *
 * Crear/actualizar un evento v2 = SOLO las 4 marcas de tiempo
 * (published_at <= available_from <= claims_close_at <= pickup_deadline) +
 * status + título/descripción + pickup_schedule_info + notas markdown de
 * términos/condiciones (times_notes/conditions_notes, solo informativas).
 * CERO columnas por rol
 * (D8): las ventajas de publicación/"Lo quiero" se leen en tiempo real de la
 * matriz trust_levels_settings (advance_pub/disp_hours_default) con la regla
 * "nunca se reclama sin ver" (CHECK disp <= pub).
 *
 * Conserva: invitaciones en cascada por rol, membresías (sin rol/bonus), share
 * links y aceptación de invitaciones (eleva users.global_role).
 */

import { Request, Response } from 'express';
import pool from '../config/db.js';
import {
  determineRoleAfterInvitation,
  deriveEventSchedule,
  generateInvitationCode,
  validateEventInput,
  validateInvitationCode,
  claimFromForRole,
  visibleAtForRole,
  EVENT_STATUSES,
  VALID_ROLES,
  type Role
} from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import {
  getUser,
  upsertUser,
  upsertEvent,
  removeEvent,
  upsertEventMember,
  type StoreEvent
} from '../cache/appStore.js';

/** Which link a user receives to invite one level down the cascade. */
const NEXT_ROLE: Record<string, string | null> = {
  familiares: 'amigos',
  amigos: 'conocidos',
  conocidos: 'publico',
  publico: null
};

/** Lee la plantilla de agenda global (event_config id=1) para derivar fechas. */
async function readEventConfig(): Promise<{
  open_after_publish_hours: number;
  claims_window_hours: number;
  closing_window_hours: number;
}> {
  const defaults = { open_after_publish_hours: 24, claims_window_hours: 72, closing_window_hours: 48 };
  try {
    const res = await pool.query(
      `SELECT open_after_publish_hours, claims_window_hours, closing_window_hours
       FROM event_config WHERE id = 1`
    );
    if (res.rows.length === 0) return defaults;
    return {
      open_after_publish_hours: Number(res.rows[0].open_after_publish_hours),
      claims_window_hours: Number(res.rows[0].claims_window_hours),
      closing_window_hours: Number(res.rows[0].closing_window_hours)
    };
  } catch {
    return defaults;
  }
}

function toStoreEvent(row: any): StoreEvent {
  return {
    id: row.id,
    title: row.title ?? null,
    description: row.description ?? null,
    available_from: row.available_from,
    published_at: row.published_at ?? null,
    claims_close_at: row.claims_close_at ?? null,
    pickup_deadline: row.pickup_deadline,
    status: row.status ?? 'draft',
    pickup_schedule_info: row.pickup_schedule_info ?? null,
    times_notes: row.times_notes ?? null,
    conditions_notes: row.conditions_notes ?? null
  };
}

/**
 * POST /api/admin/events — crea un evento v2.
 * Cuando el body trae solo la fecha de publicación (ancla única) y faltan las
 * fechas derivadas, se completan con la plantilla event_config
 * (deriveEventSchedule). Valida orden y futuro con shared validators
 * (requireFuture=true: claims_close_at/pickup_deadline futuros al crear).
 */
export const createEvent = async (req: Request, res: Response): Promise<void> => {
  const {
    title,
    description,
    published_at,
    available_from,
    claims_close_at,
    pickup_deadline,
    status,
    pickup_schedule_info,
    times_notes,
    conditions_notes
  } = req.body;
  const adminCode = (req as any).adminCode || 'system';

  // 1. Ancla única → derivar el resto de fechas desde la plantilla de agenda.
  let publishedAt = published_at;
  let availableFrom = available_from;
  let claimsCloseAt = claims_close_at;
  let pickupDeadline = pickup_deadline;

  const pubParsed = publishedAt ? new Date(publishedAt) : null;
  const pubValid = pubParsed !== null && !Number.isNaN(pubParsed.getTime());

  if ((!availableFrom || !claimsCloseAt || !pickupDeadline) && pubValid) {
    const agenda = await readEventConfig();
    const sched = deriveEventSchedule(
      {
        open_after_publish_hours: agenda.open_after_publish_hours,
        claims_window_hours: agenda.claims_window_hours,
        closing_window_hours: agenda.closing_window_hours
      },
      pubParsed!
    );
    availableFrom = availableFrom ?? sched.available_from.toISOString();
    claimsCloseAt = claimsCloseAt ?? sched.claims_close_at.toISOString();
    pickupDeadline = pickupDeadline ?? sched.pickup_deadline.toISOString();
    publishedAt = publishedAt ?? sched.published_at.toISOString();
  }

  const effectiveBody = {
    title,
    description,
    published_at: publishedAt,
    available_from: availableFrom,
    claims_close_at: claimsCloseAt,
    pickup_deadline: pickupDeadline,
    pickup_schedule_info,
    times_notes,
    conditions_notes
  };

  // 2. Validación v2 (orden + fechas futuras al crear).
  const validation = validateEventInput(effectiveBody, { requireFuture: true });
  if (!validation.valid) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
    return;
  }

  const eventStatus = status ?? 'draft';
  if (!(EVENT_STATUSES as readonly string[]).includes(eventStatus)) {
    res.status(400).json({
      error: 'Validation failed',
      details: [`status must be one of: ${EVENT_STATUSES.join(', ')}`],
      timestamp: new Date().toISOString()
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eventResult = await client.query(
      `INSERT INTO events
       (title, description, published_at, available_from, claims_close_at,
        pickup_deadline, status, pickup_schedule_info, times_notes, conditions_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        title,
        description || null,
        publishedAt || null,
        availableFrom,
        claimsCloseAt || null,
        pickupDeadline,
        eventStatus,
        pickup_schedule_info || null,
        times_notes || null,
        conditions_notes || null
      ]
    );

    const eventId = eventResult.rows[0].id;

    // Generate 4 cryptic invitation codes (one per role)
    const invitationCodes: Record<string, string> = {};
    for (const role of VALID_ROLES) {
      const code = generateInvitationCode();
      invitationCodes[role] = code;
      await client.query(
        `INSERT INTO event_invitations (event_id, role, code, created_by, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [eventId, role, code, null]
      );
    }

    await client.query('COMMIT');

    const ev = eventResult.rows[0];
    upsertEvent(toStoreEvent(ev));

    await logAudit({
      action: 'EVENT_CREATED',
      adminCodeSuffix: maskAdminCode(adminCode),
      details: {
        title: title,
        published_at: publishedAt,
        available_from: availableFrom,
        claims_close_at: claimsCloseAt,
        pickup_deadline: pickupDeadline,
        timestamp: new Date().toISOString()
      }
    });

    res.status(201).json({
      success: true,
      event: {
        eventId,
        title,
        status: eventStatus,
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
 * POST /api/invitations/accept — acepta una invitación con cascada de rol.
 * La membresía en v2 no guarda rol/bonus (users.global_role es la única fuente).
 */
export const acceptInvitation = async (req: Request, res: Response): Promise<void> => {
  const { invitationCode, userUuid } = req.body;

  if (!invitationCode || !userUuid) {
    res.status(400).json({ error: 'Missing invitationCode or userUuid' });
    return;
  }
  if (!validateInvitationCode(invitationCode)) {
    res.status(400).json({ error: 'Invalid invitation code format' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invResult = await client.query(
      `SELECT ei.role, ei.event_id, e.title
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

    const { role: invitationRole, event_id: eventId, title: eventTitle } = invResult.rows[0];

    let userResult = await client.query('SELECT uuid, global_role FROM users WHERE uuid = $1', [
      userUuid
    ]);

    let currentRole = 'publico';
    if (userResult.rows.length === 0) {
      await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
        userUuid,
        'User_' + userUuid.slice(0, 8),
        'publico'
      ]);
    } else {
      currentRole = userResult.rows[0].global_role;
    }

    const newRole = determineRoleAfterInvitation(currentRole, invitationRole);
    const roleCascaded = newRole !== currentRole;

    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, invited_by, joined_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (event_id, user_uuid) DO UPDATE
       SET invited_by = $3`,
      [eventId, userUuid, null]
    );

    if (roleCascaded) {
      await client.query('UPDATE users SET global_role = $1 WHERE uuid = $2', [newRole, userUuid]);
    }

    await client.query('UPDATE event_invitations SET use_count = use_count + 1 WHERE code = $1', [
      invitationCode
    ]);

    await client.query('COMMIT');

    const existingUser = getUser(userUuid);
    upsertUser({
      uuid: userUuid,
      alias: existingUser?.alias ?? 'User_' + userUuid.slice(0, 8),
      global_role: newRole
    });
    upsertEventMember(userUuid, {
      eventId,
      invitedBy: null,
      expiracionesAcumuladas: 0,
      bloqueadoInvitar: false
    });

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
 * PATCH /api/admin/events/:id — actualiza un evento v2 (solo columnas v2) y
 * propaga los cambios de fechas a los items que las heredan.
 */
export const updateEvent = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const {
    title,
    description,
    published_at,
    available_from,
    claims_close_at,
    pickup_deadline,
    status,
    pickup_schedule_info,
    times_notes,
    conditions_notes
  } = req.body;
  const adminCode = (req as any).adminCode || 'system';

  if (status !== undefined && !(EVENT_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({
      error: 'Validation failed',
      details: [`status must be one of: ${EVENT_STATUSES.join(', ')}`],
      timestamp: new Date().toISOString()
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, title FROM events WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    // Merge de fechas (solo las traídas) para validar el orden resultante.
    const cur = existing.rows[0] && (await pool.query('SELECT * FROM events WHERE id = $1', [id])).rows[0];
    const merged = {
      title: title ?? cur.title,
      description: description !== undefined ? description : cur.description,
      published_at: published_at !== undefined ? published_at : cur.published_at,
      available_from: available_from !== undefined ? available_from : cur.available_from,
      claims_close_at: claims_close_at !== undefined ? claims_close_at : cur.claims_close_at,
      pickup_deadline: pickup_deadline !== undefined ? pickup_deadline : cur.pickup_deadline
    };
    const validation = validateEventInput(merged, { requireFuture: false });
    if (!validation.valid) {
      await client.query('ROLLBACK');
      res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
        timestamp: new Date().toISOString()
      });
      return;
    }

    const upd = await client.query(
      `UPDATE events SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         published_at = COALESCE($3, published_at),
         available_from = COALESCE($4, available_from),
         claims_close_at = COALESCE($5, claims_close_at),
         pickup_deadline = COALESCE($6, pickup_deadline),
         status = COALESCE($7, status),
         pickup_schedule_info = COALESCE($8, pickup_schedule_info),
         times_notes = COALESCE($9, times_notes),
         conditions_notes = COALESCE($10, conditions_notes),
         updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        title ?? null,
        description !== undefined ? description : null,
        published_at !== undefined ? published_at : null,
        available_from !== undefined ? available_from : null,
        claims_close_at !== undefined ? claims_close_at : null,
        pickup_deadline !== undefined ? pickup_deadline : null,
        status ?? null,
        pickup_schedule_info ?? null,
        times_notes !== undefined ? times_notes : null,
        conditions_notes !== undefined ? conditions_notes : null,
        id
      ]
    );

    await client.query('COMMIT');

    const event = upd.rows[0];
    upsertEvent(toStoreEvent(event));

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
 * DELETE /api/admin/events/:id — solo cuando el evento no tiene items.
 */
export const deleteEvent = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const adminCode = (req as any).adminCode || 'system';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemsCount = await client.query(
      'SELECT COUNT(*)::int AS n FROM items WHERE event_id = $1',
      [id]
    );
    if (itemsCount.rows[0].n > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'Cannot delete an event that still has items. Move or delete its items first.'
      });
      return;
    }

    const del = await client.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
    if (del.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    await client.query('COMMIT');

    removeEvent(id);

    await logAudit({
      action: 'EVENT_DELETED',
      adminCodeSuffix: maskAdminCode(adminCode),
      details: { timestamp: new Date().toISOString() }
    });

    res.json({ success: true, message: 'Event deleted.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Event deletion failed:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  } finally {
    client.release();
  }
};

/**
 * GET /api/admin/events/:id — detalle admin (evento + items + miembros + invites).
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
      `SELECT id, title, status, phase, visibility_level
       FROM items WHERE event_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    const members = await pool.query(
      `SELECT em.user_uuid, u.alias, u.global_role AS role, em.invited_by,
              em.expiraciones_acumuladas, em.bloqueado_invitar, em.joined_at
       FROM event_members em
       JOIN users u ON em.user_uuid = u.uuid
       WHERE em.event_id = $1 ORDER BY u.global_role, em.joined_at`,
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
 * GET /api/events/:eventId — evento público + ventanas dinámicas por rol
 * (visibleAtForRole / claimFromForRole desde la matriz, cero columnas por evento).
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

    // Ventanas dinámicas por rol si hay usuario autenticado.
    let roleWindows: Record<string, unknown> | null = null;
    if (userUuid) {
      try {
        const userRes = await pool.query('SELECT global_role FROM users WHERE uuid = $1', [userUuid]);
        const role = (userRes.rows[0]?.global_role || 'publico') as Role;
        const trust = await pool.query(
          `SELECT advance_pub_hours_default, advance_disp_hours_default
           FROM trust_levels_settings WHERE id = $1`,
          [role]
        );
        const advancePubHours = Number(trust.rows[0]?.advance_pub_hours_default ?? 0);
        const advanceDispHours = Number(trust.rows[0]?.advance_disp_hours_default ?? 0);
        const visible = visibleAtForRole(event.published_at, advancePubHours);
        const claimFrom = claimFromForRole(event.available_from, advanceDispHours);
        roleWindows = {
          role,
          advance_pub_hours: advancePubHours,
          advance_disp_hours: advanceDispHours,
          visible_at: visible ? visible.toISOString() : null,
          claim_from: claimFrom ? claimFrom.toISOString() : null
        };
      } catch (error) {
        console.warn('Could not compute role windows:', error);
      }
    }

    res.json({ event, roleWindows });
  } catch (error) {
    console.error('Failed to fetch event:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

/** GET /api/events — listado paginado. */
export const listEvents = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const result = await pool.query(
      `SELECT e.id, e.title, e.description, e.published_at, e.available_from,
              e.claims_close_at, e.pickup_deadline, e.status, e.created_at,
              (SELECT COUNT(*)::int FROM items i WHERE i.event_id = e.id) AS item_count
       FROM events e
       ORDER BY e.created_at DESC
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

/**
 * GET /api/events/:id/invite/:code — valida un código de invitación.
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
 * GET /api/invitations/resolve?code=CODE — resuelve un código suelto (sin event_id).
 */
export const resolveInvitation = async (req: Request, res: Response): Promise<void> => {
  const { code } = req.query;

  if (!code || typeof code !== 'string' || !validateInvitationCode(code)) {
    res.status(400).json({ error: 'Invalid invitation code format' });
    return;
  }

  try {
    const inv = await pool.query(
      `SELECT ei.role, ei.is_active, ei.event_id, e.title
       FROM event_invitations ei
       JOIN events e ON ei.event_id = e.id
       WHERE ei.code = $1
       LIMIT 1`,
      [code]
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
      eventId: inv.rows[0].event_id,
      eventTitle: inv.rows[0].title,
      role: inv.rows[0].role,
      isActive: true
    });
  } catch (error) {
    console.error('Invitation resolution failed:', error);
    res.status(500).json({ error: 'Failed to resolve invitation' });
  }
};

/**
 * GET /api/events/:id/share-link — link de invitación del siguiente rol en la cascada.
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
    const memberRes = await pool.query(
      'SELECT bloqueado_invitar FROM event_members WHERE event_id = $1 AND user_uuid = $2',
      [id, userUuid]
    );
    if (memberRes.rows[0]?.bloqueado_invitar) {
      res.status(403).json({
        error: 'Has perdido temporalmente el derecho a invitar por exceder el umbral de expiraciones.'
      });
      return;
    }

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
