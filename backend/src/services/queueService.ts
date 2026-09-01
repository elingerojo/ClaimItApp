/**
 * backend/src/services/queueService.ts
 *
 * Shared queue logic for the time-automation features:
 *  - getPickupWindowHours(): pickup window inherited from the item's event
 *    (default 24h) — used to compute collection deadlines.
 *  - assignPickupDeadlineToFirst(): assign/refresh the deadline for the
 *    current first-in-line claim.
 *  - advanceQueue(): recompute an item's status from its remaining queue and,
 *    if there is a new first-in-line, assign it a pickup deadline.
 *
 * All functions run inside the caller's transaction (they receive the pool
 * client). Used by claimsController (claim creation + pickup confirmation),
 * adminController (manual eviction) and scheduler (deadline expiry job).
 */

export interface AdvanceQueueResult {
  newStatus: string;
  newFirstUsername: string | null;
}

/**
 * Pickup window in hours for an item: inherited from its event (events.pickup_window_hours),
 * falling back to 24h when the item has no event.
 */
export async function getPickupWindowHours(itemId: string, client: any): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(e.pickup_window_hours, 24) AS hours
     FROM items i
     LEFT JOIN events e ON i.event_id = e.id
     WHERE i.id = $1`,
    [itemId]
  );
  return res.rows.length > 0 ? Number(res.rows[0].hours) : 24;
}

/**
 * Assign (or refresh) the pickup deadline to the current first-in-line claim.
 * Returns the username of that first claim, or null when the queue is empty.
 */
export async function assignPickupDeadlineToFirst(itemId: string, client: any): Promise<string | null> {
  const res = await client.query(
    `SELECT c.id, u.alias AS username
     FROM claims c
     JOIN users u ON c.user_uuid = u.uuid
     WHERE c.item_id = $1 AND COALESCE(c.picked_up, false) = false
     ORDER BY c.claimed_at ASC, c.id ASC
     LIMIT 1`,
    [itemId]
  );

  if (res.rows.length === 0) return null;

  const first = res.rows[0];
  const windowHours = await getPickupWindowHours(itemId, client);

  await client.query(
    `UPDATE claims
     SET pickup_deadline = NOW() + (interval '1 hour' * $1)
     WHERE id = $2 AND COALESCE(picked_up, false) = false`,
    [windowHours, first.id]
  );

  return first.username;
}

/**
 * Recompute an item's lifecycle status from its remaining (not picked up)
 * claims and assign a pickup deadline to the new first-in-line, if any.
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
  if (count > 0) {
    const first = remaining[0];
    newFirstUsername = first.username;
    const windowHours = await getPickupWindowHours(itemId, client);
    await client.query(
      `UPDATE claims
       SET pickup_deadline = NOW() + (interval '1 hour' * $1)
       WHERE id = $2 AND COALESCE(picked_up, false) = false`,
      [windowHours, first.id]
    );
  }

  return { newStatus, newFirstUsername };
}
