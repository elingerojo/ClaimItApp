/**
 * backend/src/services/scheduler.ts
 *
 * Time automations (Prompt_time_automations.md, "Jobs Programados"):
 *
 *  - releaseBatches()      every 60s    broadcast items whose available_from arrived
 *  - verifyDeadlines()     every 5 min  evict claims whose pickup_deadline passed and
 *                                       auto-advance their queue (FIFO)
 *  - updateEventStatus()   every 5 min  advance events.status
 *                                       (draft -> scheduled -> active -> completed)
 *
 * Single Railway instance (replicas=1), so in-memory tracking (releasedItemIds)
 * is valid. Jobs write to Neon and keep the RAM store (appStore) in sync via
 * write-through so the SSE feed stays consistent without touching Neon on reads.
 */
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import { removeClaimFromItem } from '../cache/appStore.js';
import { advanceQueue } from './queueService.js';

const RELEASE_INTERVAL_MS = 60_000;
const DEADLINE_INTERVAL_MS = 5 * 60_000;
const EVENT_STATUS_INTERVAL_MS = 5 * 60_000;

/** Items already released in this process run (avoid re-broadcasting forever). */
const releasedItemIds = new Set<string>();

/**
 * Prime the released set on startup so items that are already past their
 * available_from do not emit a batch-release event at boot.
 */
async function primeReleasedItems(): Promise<void> {
  try {
    const res = await pool.query(
      'SELECT id FROM items WHERE available_from IS NOT NULL AND available_from <= NOW()'
    );
    for (const row of res.rows) releasedItemIds.add(row.id);
    console.log(`[Scheduler] Primed ${res.rows.length} already-released item(s).`);
  } catch (err) {
    console.error('[Scheduler] primeReleasedItems failed:', err);
  }
}

/**
 * Release batches: when an item's available_from arrives, emit item_updated so
 * the frontend flips it to claimable. Runs every 60s.
 */
export async function releaseBatches(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id FROM items
       WHERE available_from IS NOT NULL AND available_from <= NOW()`
    );

    for (const row of res.rows) {
      if (releasedItemIds.has(row.id)) continue;
      releasedItemIds.add(row.id);
      broadcastSseEvent('item_updated', {
        itemId: row.id,
        status: 'available',
        reason: 'batch_released'
      });
      console.log(`[Scheduler] Batch released item ${row.id}`);
    }
  } catch (err) {
    console.error('[Scheduler] releaseBatches failed:', err);
  } finally {
    client.release();
  }
}

/**
 * Verify deadlines: evict claims whose pickup_deadline passed and auto-advance
 * each affected item's queue. Runs every 5 minutes.
 */
export async function verifyDeadlines(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT c.item_id, c.user_uuid, u.alias AS username
       FROM claims c
       JOIN users u ON c.user_uuid = u.uuid
       WHERE COALESCE(c.picked_up, false) = false
         AND c.pickup_deadline IS NOT NULL
         AND c.pickup_deadline <= NOW()
       ORDER BY c.item_id, c.pickup_deadline ASC`
    );

    // Group expired claims by item so each item is processed in one transaction.
    const byItem = new Map<string, Array<{ userUuid: string; username: string }>>();
    for (const r of res.rows) {
      if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
      byItem.get(r.item_id)!.push({ userUuid: r.user_uuid, username: r.username });
    }

    for (const [itemId, evicted] of byItem) {
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
        console.log(
          `[Scheduler] Deadline expiry: evicted ${evicted.length} on item ${itemId}, new first: ${newFirstUsername}`
        );
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Scheduler] verifyDeadlines failed for item ${itemId}:`, err);
      }
    }
  } catch (err) {
    console.error('[Scheduler] verifyDeadlines query failed:', err);
  } finally {
    client.release();
  }
}

/**
 * Advance event lifecycle: draft -> scheduled -> active -> completed.
 * Runs every 5 minutes.
 */
export async function updateEventStatus(): Promise<void> {
  const client = await pool.connect();
  try {
    // draft -> scheduled: published_at is within the next day (or already passed)
    await client.query(
      `UPDATE events SET status = 'scheduled', updated_at = NOW()
       WHERE status = 'draft'
         AND published_at IS NOT NULL
         AND published_at <= NOW() + interval '1 day'`
    );

    // scheduled/draft -> active: public availability window reached
    await client.query(
      `UPDATE events SET status = 'active', updated_at = NOW()
       WHERE status IN ('draft','scheduled')
         AND available_from <= NOW()`
    );

    // active -> completed: no item of the event is waiting in a queue
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
 * Start the scheduled jobs. Call once after rehydrateAll() in index.ts.
 */
export function startScheduler(): void {
  primeReleasedItems().then(() => {
    setInterval(() => {
      releaseBatches().catch(() => {});
    }, RELEASE_INTERVAL_MS);
  });

  setInterval(() => {
    verifyDeadlines().catch(() => {});
  }, DEADLINE_INTERVAL_MS);

  setInterval(() => {
    updateEventStatus().catch(() => {});
  }, EVENT_STATUS_INTERVAL_MS);

  // Run the time-sensitive jobs once shortly after boot (no wait for first tick)
  setTimeout(() => {
    verifyDeadlines().catch(() => {});
    updateEventStatus().catch(() => {});
  }, 5000);

  console.log(
    `[Scheduler] Jobs started: releaseBatches every ${RELEASE_INTERVAL_MS / 1000}s, ` +
      `verifyDeadlines + updateEventStatus every ${DEADLINE_INTERVAL_MS / 60000} min.`
  );
}
