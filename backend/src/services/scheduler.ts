/**
 * backend/src/services/scheduler.ts
 *
 * Time automations (Prompt_time_automations.md, "Jobs Programados"):
 *
 *  - expireOverdueClaims()  catch-up: evicts claims whose pickup_deadline passed,
 *                           auto-advances the queue and applies trust sanctions.
 *  - runLazyCatchUp()       triggers expireOverdueClaims() ONLY when the RAM
 *                           store has overdue deadlines (checks in memory first,
 *                           so it touches Neon only when there is real work).
 *  - releaseBatches()       broadcast items whose available_from arrived.
 *  - updateEventStatus()    advance events.status (draft -> scheduled -> active
 *                           -> closing -> closed).
 *
 * Lazy mode (default): no periodic polling. The catch-up runs on activity
 * (feed read, claim, pickup, SSE connect) so Neon can autosuspend when idle
 * (preserves the "siesta" / zero-traffic design and the compute allowance).
 *
 * Optional poll mode: set SCHEDULER_ENABLED=true to restore fixed-interval jobs
 * (SCHEDULER_RELEASE_SEC, SCHEDULER_DEADLINE_MIN) for users who prefer the
 * queue to advance in real time even with zero traffic.
 */
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import {
  getItems,
  getEvent,
  refreshClaimDeadline,
  removeClaimFromItem,
  removeItem,
  setEventStatusInStore
} from '../cache/appStore.js';
import { logAudit } from '../utils/auditLog.js';
import { advanceQueue } from './queueService.js';
import { applyExpirationSanction } from './trustSanctions.js';

/**
 * True when the RAM store holds at least one queue entry with a passed
 * pickup deadline. Pure in-memory check (never touches Neon).
 */
export function hasOverdueDeadlinesInStore(): boolean {
  const now = Date.now();
  for (const item of getItems()) {
    for (const claim of item.queue) {
      if (claim.pickupDeadline && new Date(claim.pickupDeadline).getTime() <= now) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Catch-up: evict claims whose pickup_deadline passed and auto-advance each
 * affected item's queue (applying trust sanctions per role). Each item is
 * processed in its own transaction. Returns the number of evicted claims.
 */
export async function expireOverdueClaims(): Promise<number> {
  const client = await pool.connect();
  let total = 0;
  try {
    const res = await client.query(
      `SELECT c.item_id, c.user_uuid, u.alias AS username, i.event_id AS event_id
       FROM claims c
       JOIN users u ON c.user_uuid = u.uuid
       JOIN items i ON c.item_id = i.id
       WHERE COALESCE(c.picked_up, false) = false
         AND c.pickup_deadline IS NOT NULL
         AND c.pickup_deadline <= NOW()
       ORDER BY c.item_id, c.pickup_deadline ASC`
    );

    // Group expired claims by item so each item is processed in one transaction.
    const byItem = new Map<
      string,
      { eventId: string | null; users: Array<{ userUuid: string; username: string }> }
    >();
    for (const r of res.rows) {
      if (!byItem.has(r.item_id)) {
        byItem.set(r.item_id, { eventId: r.event_id ?? null, users: [] });
      }
      byItem.get(r.item_id)!.users.push({ userUuid: r.user_uuid, username: r.username });
    }

    for (const [itemId, { eventId, users: evicted }] of byItem) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT id FROM items WHERE id = $1 FOR UPDATE', [itemId]);

        // Evict every expired claim on this item
        for (const u of evicted) {
          await client.query('DELETE FROM claims WHERE item_id = $1 AND user_uuid = $2', [
            itemId,
            u.userUuid
          ]);
        }

        const { newStatus, newFirstUsername, newFirstUuid, newFirstPickupDeadline } =
          await advanceQueue(itemId, client);

        // Tolerancia a expiraciones: incrementar contador y aplicar sanción por rol
        if (eventId) {
          for (const u of evicted) {
            await applyExpirationSanction(eventId, u.userUuid, client);
          }
        }

        await client.query('COMMIT');

        // Write-through: keep the RAM store consistent with Neon
        for (const u of evicted) {
          removeClaimFromItem(itemId, u.userUuid, newStatus);
        }
        if (newFirstUuid) {
          refreshClaimDeadline(itemId, newFirstUuid, newFirstPickupDeadline ?? null);
        }

        for (const u of evicted) {
          broadcastSseEvent('item_updated', {
            itemId,
            status: newStatus,
            userUuid: u.userUuid,
            username: u.username,
            evicted: true,
            evictedUsername: u.username,
            newFirstUsername,
            newFirstUuid,
            newFirstPickupDeadline,
            reason: 'deadline_expired'
          });
        }
        total += evicted.length;
        console.log(
          `[Scheduler] Deadline expiry: evicted ${evicted.length} on item ${itemId}, new first: ${newFirstUsername}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Scheduler] expireOverdueClaims failed for item ${itemId}:`, err);
      }
    }
  } catch (err) {
    console.error('[Scheduler] expireOverdueClaims query failed:', err);
  } finally {
    client.release();
  }
  return total;
}

/**
 * Lazy catch-up hook: only touches Neon when the RAM store has overdue
 * deadlines. Call this on activity (feed read, claim, pickup, SSE connect).
 */
export async function runLazyCatchUp(): Promise<number> {
  let total = 0;
  if (hasOverdueDeadlinesInStore()) total += await expireOverdueClaims();
  // Purga perezosa: solo toca Neon cuando ya existen items de eventos 'closed'
  // más allá de la gracia configurada (no gasta compute en el caso común).
  if (hasPurgeableClosedEvents()) total += await purgeExpiredClosedInventory();
  return total;
}

/**
 * Alias kept for the optional periodic poll.
 */
export async function verifyDeadlines(): Promise<void> {
  await expireOverdueClaims();
}

/**
 * Release batches: when an item's available_from arrives, emit item_updated so
 * the frontend flips it to claimable. Only used in the optional poll mode —
 * the feed already computes canClaim dynamically, so this is not required for
 * correctness.
 */
export async function releaseBatches(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id FROM items
       WHERE available_from IS NOT NULL AND available_from <= NOW()`
    );
    for (const row of res.rows) {
      broadcastSseEvent('item_updated', {
        itemId: row.id,
        status: 'available',
        reason: 'batch_released'
      });
    }
  } catch (err) {
    console.error('[Scheduler] releaseBatches failed:', err);
  } finally {
    client.release();
  }
}

/**
 * Advance event lifecycle: draft -> scheduled -> active -> closing -> closed.
 * Only used in the optional poll mode.
 */
export async function updateEventStatus(): Promise<void> {
  const client = await pool.connect();
  try {
    // Write-through de cada transición a RAM (setEventStatusInStore) para que
    // el índice por estatus y el feed reflejen el estatus real del evento.

    // draft -> scheduled: the event is about to be published
    const scheduled = await client.query(
      `UPDATE events SET status = 'scheduled', updated_at = NOW()
       WHERE status = 'draft'
         AND published_at IS NOT NULL
         AND published_at <= NOW() + interval '1 day'
       RETURNING id`
    );
    for (const r of scheduled.rows) setEventStatusInStore(r.id, 'scheduled');

    // scheduled -> active: reservations opened (available_from reached)
    const active = await client.query(
      `UPDATE events SET status = 'active', updated_at = NOW()
       WHERE status IN ('draft','scheduled')
         AND available_from <= NOW()
       RETURNING id`
    );
    for (const r of active.rows) setEventStatusInStore(r.id, 'active');

    // active -> closing: no more new claims accepted (claims_close_at reached)
    const closing = await client.query(
      `UPDATE events SET status = 'closing', updated_at = NOW()
       WHERE status = 'active'
         AND claims_close_at IS NOT NULL
         AND claims_close_at <= NOW()
       RETURNING id`
    );
    for (const r of closing.rows) setEventStatusInStore(r.id, 'closing');

    // closing -> closed: pickup window over (pickup_deadline reached)
    const closed = await client.query(
      `UPDATE events SET status = 'closed', updated_at = NOW()
       WHERE status IN ('active','closing')
         AND pickup_deadline IS NOT NULL
         AND pickup_deadline <= NOW()
       RETURNING id`
    );
    for (const r of closed.rows) setEventStatusInStore(r.id, 'closed');
  } catch (err) {
    console.error('[Scheduler] updateEventStatus failed:', err);
  } finally {
    client.release();
  }
}

/**
 * Días de gracia (post pickup_deadline) tras los cuales se purgan los items de
 * un evento 'closed'. Configurable vía PURGE_CLOSED_DAYS (default 30).
 */
export function purgeGraceDays(): number {
  const days = parseInt(process.env.PURGE_CLOSED_DAYS || '30', 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

/**
 * Chequeo en memoria (sin tocar Neon): existe al menos un item cuyo evento está
 * 'closed' y cuya pickup_deadline ya superó la gracia configurada.
 */
export function hasPurgeableClosedEvents(): boolean {
  const cutoff = Date.now() - purgeGraceDays() * 86_400_000;
  for (const item of getItems()) {
    if (!item.eventId) continue;
    const evt = getEvent(item.eventId);
    if (evt?.status === 'closed' && evt.pickup_deadline && new Date(evt.pickup_deadline).getTime() < cutoff) {
      return true;
    }
  }
  return false;
}

/**
 * Purga los items de eventos 'closed' cuya fecha límite de recogida ya venció
 * hace al menos PURGE_CLOSED_DAYS días (default 30). Elimina items (+ claims
 * por ON DELETE CASCADE) en Neon y en RAM, emite item_deleted por SSE y audita.
 * Previene que el histórico de eventos cerrados se acumule indefinidamente.
 * Los eventos en sí se conservan como registro.
 */
export async function purgeExpiredClosedInventory(): Promise<number> {
  const graceDays = purgeGraceDays();
  const cutoff = new Date(Date.now() - graceDays * 86_400_000).toISOString();
  const client = await pool.connect();
  let purged = 0;
  const eventIds = new Set<string>();
  try {
    const res = await client.query(
      `SELECT i.id AS item_id, e.id AS event_id
       FROM events e
       JOIN items i ON i.event_id = e.id
       WHERE e.status = 'closed'
         AND e.pickup_deadline IS NOT NULL
         AND e.pickup_deadline < $1::timestamptz`,
      [cutoff]
    );
    if (res.rows.length === 0) return 0;

    for (const r of res.rows) {
      // claims asociados se eliminan por ON DELETE CASCADE del items
      await client.query('DELETE FROM items WHERE id = $1', [r.item_id]);
      removeItem(r.item_id); // write-through RAM (invalida el índice por estatus)
      broadcastSseEvent('item_deleted', { itemId: r.item_id, reason: 'closed_grace_elapsed' });
      eventIds.add(r.event_id);
      purged++;
    }

    await logAudit({
      action: 'ITEMS_PURGED',
      adminCodeSuffix: 'system',
      details: { count: purged, eventIds: [...eventIds], graceDays, cutoff }
    });
    console.log(`[Scheduler] Purged ${purged} items from closed events (grace ${graceDays}d).`);
  } catch (err) {
    console.error('[Scheduler] purgeExpiredClosedInventory failed:', err);
  } finally {
    client.release();
  }
  return purged;
}

/**
 * Start the scheduled jobs. By default runs in LAZY mode (no polling) so Neon
 * can autosuspend and preserve the compute allowance. Set SCHEDULER_ENABLED=true
 * to enable the fixed-interval jobs instead.
 */
export function startScheduler(): void {
  const enabled = process.env.SCHEDULER_ENABLED === 'true';

  if (!enabled) {
    console.log(
      '[Scheduler] LAZY MODE (default): expiración por actividad (catch-up). ' +
        'Neon puede autosuspenderse. Para polls periódicos setea SCHEDULER_ENABLED=true.'
    );
    return;
  }

  const releaseSec = Math.max(parseInt(process.env.SCHEDULER_RELEASE_SEC || '300', 10), 60);
  const deadlineMin = Math.max(parseInt(process.env.SCHEDULER_DEADLINE_MIN || '15', 10), 5);
  const purgeHours = Math.max(parseInt(process.env.SCHEDULER_PURGE_HOURS || '24', 10), 1);

  setInterval(() => {
    releaseBatches().catch(() => {});
  }, releaseSec * 1000);
  setInterval(() => {
    verifyDeadlines().catch(() => {});
  }, deadlineMin * 60 * 1000);
  setInterval(() => {
    updateEventStatus().catch(() => {});
  }, deadlineMin * 60 * 1000);
  setInterval(() => {
    purgeExpiredClosedInventory().catch(() => {});
  }, purgeHours * 3600 * 1000);

  console.log(
    `[Scheduler] POLL MODE enabled: releaseBatches every ${releaseSec}s, ` +
      `verifyDeadlines + updateEventStatus every ${deadlineMin} min, ` +
      `purgeClosedInventory every ${purgeHours}h.`
  );
}
