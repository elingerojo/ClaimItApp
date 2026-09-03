/**
 * backend/src/services/queueService.ts
 *
 * Shared queue logic for the time-automation features (single source of truth
 * for the pickup deadline):
 *
 *  - resolveRoleForEvent(): membership role of the user in the item's event,
 *    falling back to the user's GLOBAL role when there is no membership. This is
 *    the SAME resolution used by the feed for visibility/price/availability.
 *  - resolvePickupWindow(): per-role pickup window of the EVENT
 *    (events.<rol>_pickup_hours) seeded from the trust matrix as an editable
 *    suggestion; matrix default as fallback. Replaces the old single
 *    events.pickup_window_hours authority.
 *  - computePickupDeadline(): meta = assignment + window, then clamped between
 *    the collection availability floor (events.available_from) and the ceiling
 *    (min(events.pickup_deadline, items.expires_at)).
 *  - assignPickupDeadlineToFirst(): freeze role + window + deadline on the
 *    claim (F1) when it becomes first in line.
 *  - advanceQueue(): recompute status and assign a FRESH frozen deadline to the
 *    new first-in-line (never NOW + raw window).
 *
 * All functions run inside the caller's transaction (they receive the pool
 * client). Used by claimsController (claim + pickup), adminController (evict)
 * and scheduler (deadline expiry).
 */

import { resolveEffectiveRole, resolvePickupHoursField } from '@claimitapp/shared';

export interface AdvanceQueueResult {
  newStatus: string;
  newFirstUsername: string | null;
  newFirstUuid?: string | null;
  newFirstPickupDeadline?: string | null;
}

export interface FirstAssignment {
  username: string | null;
  userUuid: string | null;
  pickupDeadline: string | null;
  roleAtAssignment: string | null;
  pickupWindowHours: number | null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Context of an item for deadline resolution: its event (if any) with the
 * per-role pickup hours + collection availability bounds.
 */
async function getItemPickupContext(itemId: string, client: any) {
  const res = await client.query(
    `SELECT i.event_id, i.expires_at AS item_expires_at,
            e.available_from, e.pickup_deadline, e.claims_close_at,
            e.familiares_pickup_hours, e.amigos_pickup_hours,
            e.conocidos_pickup_hours, e.publico_pickup_hours,
            e.pickup_window_hours
     FROM items i
     LEFT JOIN events e ON i.event_id = e.id
     WHERE i.id = $1`,
    [itemId]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

/**
 * Effective role of a user in an event. Fase 2: roles are GLOBAL (single source
 * of truth relative to the sole admin), so the resolved role is the user's
 * global role; eventId is kept only for call-site compatibility. Mirrors the
 * feed resolution so the deadline is consistent with what the claimant sees.
 */
export async function resolveRoleForEvent(
  _eventId: string | null,
  userUuid: string,
  client: any
): Promise<string> {
  const userRes = await client.query('SELECT global_role FROM users WHERE uuid = $1', [userUuid]);
  const globalRole = userRes.rows[0]?.global_role ?? null;

  return resolveEffectiveRole(null, globalRole);
}

/**
 * Resolve the pickup WINDOW (hours) for a role on an item. Single source:
 *  - events.<rol>_pickup_hours (event-level config, editable suggestion) → highest
 *  - trust_levels_settings.intervalo_recoleccion_horas_default (matrix default)
 *  - 24h legacy fallback when no event / no setting exists.
 */
export async function resolvePickupWindow(
  itemId: string,
  role: string,
  client: any
): Promise<number> {
  const ctx = await getItemPickupContext(itemId, client);
  const field = resolvePickupHoursField(role);
  if (!field) return 24;

  // 1. Event-level per-role pickup hours (nullable).
  let windowHours: number | null = null;
  if (ctx?.event_id && field && ctx[field] != null) {
    windowHours = Number(ctx[field]);
  }

  // 2. Trust-matrix default by role (suggestion).
  if (windowHours == null) {
    const ts = await client.query(
      'SELECT intervalo_recoleccion_horas_default FROM trust_levels_settings WHERE id = $1',
      [role]
    );
    if (ts.rows.length > 0 && ts.rows[0].intervalo_recoleccion_horas_default != null) {
      windowHours = Number(ts.rows[0].intervalo_recoleccion_horas_default);
    }
  }

  // 3. Legacy fallback: legacy events.pickup_window_hours, then 24h.
  if (windowHours == null && ctx?.pickup_window_hours != null) {
    windowHours = Number(ctx.pickup_window_hours);
  }

  return windowHours != null && windowHours > 0 ? windowHours : 24;
}

/**
 * Compute the collection deadline for the first-in-line:
 *   meta = reference + window
 *   deadline = clamp(meta, [available_from, min(pickup_deadline, item.expires_at)])
 *
 * Floor: events.available_from (no delivery before the event opens).
 * Ceiling: events.pickup_deadline (end of closing), also capped by the item's
 * own expires_at when present.
 */
function computePickupDeadline(
  reference: Date,
  windowHours: number,
  ctx: any
): Date {
  const metaMs = reference.getTime() + windowHours * HOUR_MS;
  let floorMs = -Infinity;
  let ceilingMs = Infinity;

  if (ctx?.event_id) {
    if (ctx.available_from) floorMs = new Date(ctx.available_from).getTime();
    if (ctx.pickup_deadline) ceilingMs = new Date(ctx.pickup_deadline).getTime();
  }
  if (ctx?.item_expires_at) {
    const exp = new Date(ctx.item_expires_at).getTime();
    if (exp < ceilingMs) ceilingMs = exp;
  }

  return new Date(Math.min(Math.max(metaMs, floorMs), ceilingMs));
}

/**
 * Freeze role + window and assign the pickup deadline to the current
 * first-in-line claim. The deadline is computed from the claim's OWN
 * claimed_at (the moment the user became first by claiming) and clamped to the
 * event's collection availability. Returns the frozen snapshot.
 */
async function freezeDeadlineOnFirst(itemId: string, client: any): Promise<FirstAssignment> {
  const res = await client.query(
    `SELECT c.id, c.user_uuid, u.alias AS username, c.claimed_at
     FROM claims c
     JOIN users u ON c.user_uuid = u.uuid
     WHERE c.item_id = $1 AND COALESCE(c.picked_up, false) = false
     ORDER BY c.claimed_at ASC, c.id ASC
     LIMIT 1`,
    [itemId]
  );

  if (res.rows.length === 0) {
    return { username: null, userUuid: null, pickupDeadline: null, roleAtAssignment: null, pickupWindowHours: null };
  }

  const first = res.rows[0];
  const ctx = await getItemPickupContext(itemId, client);
  const role = await resolveRoleForEvent(ctx?.event_id ?? null, first.user_uuid, client);
  const windowHours = await resolvePickupWindow(itemId, role, client);

  // F1: the reference instant is when the user BECOMES first in line — for a
  // brand-new claim that is its claimed_at (~now); for a promoted waiter it is
  // the moment the queue advances (now), never a stale claimed_at in the past.
  const reference = new Date(Math.max(new Date(first.claimed_at).getTime(), Date.now()));
  const deadline = computePickupDeadline(reference, windowHours, ctx);

  await client.query(
    `UPDATE claims
     SET pickup_deadline = $1, role_at_assignment = $2, pickup_window_hours = $3
     WHERE id = $4 AND COALESCE(picked_up, false) = false`,
    [deadline.toISOString(), role, windowHours, first.id]
  );

  return {
    username: first.username,
    userUuid: first.user_uuid,
    pickupDeadline: deadline.toISOString(),
    roleAtAssignment: role,
    pickupWindowHours: windowHours
  };
}

/**
 * Assign (or refresh) a frozen pickup deadline to the current first-in-line.
 * Returns the username of that first claim, or null when the queue is empty.
 */
export async function assignPickupDeadlineToFirst(itemId: string, client: any): Promise<string | null> {
  const assignment = await freezeDeadlineOnFirst(itemId, client);
  return assignment.username;
}

/**
 * Recompute an item's lifecycle status from its remaining (not picked up)
 * claims and assign a fresh frozen pickup deadline to the new first-in-line.
 *
 * Status mapping (strict FIFO, no role-based bypass):
 *   0 claims -> available, 1-2 -> waitlist_open, 3+ -> unavailable
 */
export async function advanceQueue(itemId: string, client: any): Promise<AdvanceQueueResult> {
  const claimsRes = await client.query(
    `SELECT c.id, u.alias AS username
     FROM claims c
     JOIN users u ON c.user_uuid = u.uuid
     WHERE c.item_id = $1 AND COALESCE(c.picked_up, false) = false
     ORDER BY c.claimed_at ASC, c.id ASC`,
    [itemId]
  );

  const remaining = claimsRes.rows;
  const count = remaining.length;

  let newStatus = 'available';
  if (count === 1 || count === 2) newStatus = 'waitlist_open';
  else if (count >= 3) newStatus = 'unavailable';

  await client.query('UPDATE items SET status = $1 WHERE id = $2', [newStatus, itemId]);

  let newFirstUsername: string | null = null;
  let newFirstUuid: string | null = null;
  let newFirstPickupDeadline: string | null = null;

  if (count > 0) {
    const assignment = await freezeDeadlineOnFirst(itemId, client);
    newFirstUsername = assignment.username;
    newFirstUuid = assignment.userUuid;
    newFirstPickupDeadline = assignment.pickupDeadline;
  }

  return { newStatus, newFirstUsername, newFirstUuid, newFirstPickupDeadline };
}
