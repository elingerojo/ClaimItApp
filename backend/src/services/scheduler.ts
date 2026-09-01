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
 *                           -> completed).
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
import { getItems, removeClaimFromItem } from '../cache/appStore.js';
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

        const { newStatus, newFirstUsername } = await advanceQueue(itemId, client);

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

        for (const u of evicted) {
          broadcastSseEvent('item_updated', {
            itemId,
            status: newStatus,
            userUuid: u.userUuid,
            username: u.username,
            evicted: true,
            evictedUsername: u.username,
            newFirstUsername,
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
  if (!hasOverdueDeadlinesInStore()) return 0;
  return expireOverdueClaims();
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
 * Advance event lifecycle: draft -> scheduled -> active -> completed.
 * Only used in the optional poll mode.
 */
export async function updateEventStatus(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE events SET status = 'scheduled', updated_at = NOW()
       WHERE status = 'draft'
         AND published_at IS NOT NULL
         AND published_at <= NOW() + interval '1 day'`
    );
    await client.query(
      `UPDATE events SET status = 'active', updated_at = NOW()
       WHERE status IN ('draft','scheduled')
         AND available_from <= NOW()`
    );
    await client.query(
      `UPDATE events SET status = 'completed', updated_at = NOW()
       WHERE status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM items i
           WHERE i.event_id = events.id AND i.status <> 'available'
         )`
    );
  } catch (err) {
    console.error('[Scheduler] updateEventStatus failed:', err);
  } finally {
    client.release();
  }
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

  setInterval(() => {
    releaseBatches().catch(() => {});
  }, releaseSec * 1000);
  setInterval(() => {
    verifyDeadlines().catch(() => {});
  }, deadlineMin * 60 * 1000);
  setInterval(() => {
    updateEventStatus().catch(() => {});
  }, deadlineMin * 60 * 1000);

  console.log(
    `[Scheduler] POLL MODE enabled: releaseBatches every ${releaseSec}s, ` +
      `verifyDeadlines + updateEventStatus every ${deadlineMin} min.`
  );
}
