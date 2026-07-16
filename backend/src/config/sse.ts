import { Response } from 'express';
import pool from './db.js';

// Memory array to keep track of active HTTP response streams
let clients: Response[] = [];

// Feed history cache (circular buffer, max N=50)
const MAX_HISTORY = 50;
const BASE_IDLE_FLUSH_MS = 5 * 60 * 1000; // 5 minutes base
const IDLE_INCREMENT_MS = 2 * 60 * 1000;  // +2 minutes each consecutive idle
let idleFlushCount = 0;                    // increments after each flush

interface FeedEntry {
  event: string;
  data: any;
  timestamp: Date;
}

let feedHistory: FeedEntry[] = [];
let idleTimer: NodeJS.Timeout | null = null;
let isFlushing = false;

/**
 * Loads the last N feed entries from Neon into the in-memory cache
 */
export const initializeFeedHistory = async (): Promise<void> => {
  try {
    const result = await pool.query(
      'SELECT event_name, event_data, created_at FROM feed_history ORDER BY created_at DESC LIMIT $1',
      [MAX_HISTORY]
    );
    // Reverse to maintain chronological ascending order (oldest first)
    feedHistory = result.rows.reverse().map((row: any) => ({
      event: row.event_name,
      data: row.event_data,
      timestamp: row.created_at
    }));
    console.log(`[SSE] Feed cache initialized with ${feedHistory.length} historical events`);
  } catch (err) {
    console.warn('[SSE] Could not load feed history from Neon, starting fresh:', (err as Error).message);
  }
};

/**
 * Resets the idle timer. Called every time a new event is broadcast.
 */
function getCurrentIdleTimeout(): number {
  return BASE_IDLE_FLUSH_MS + idleFlushCount * IDLE_INCREMENT_MS;
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const timeout = getCurrentIdleTimeout();
  console.log(`[SSE] Idle timer set to ${timeout / 60000} min (flush #${idleFlushCount + 1})`);
  idleTimer = setTimeout(flushToNeon, timeout);
}

/**
 * Flushes the in-memory feed cache to Neon (called when server is idle)
 */
async function flushToNeon(): Promise<void> {
  if (isFlushing || feedHistory.length === 0) return;
  isFlushing = true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM feed_history');
    for (const entry of feedHistory) {
      await client.query(
        'INSERT INTO feed_history (event_name, event_data, created_at) VALUES ($1, $2::jsonb, $3)',
        [entry.event, JSON.stringify(entry.data), entry.timestamp]
      );
    }
    await client.query('COMMIT');
    idleFlushCount++;
    console.log(`[SSE] Flushed ${feedHistory.length} events to Neon (idle round #${idleFlushCount})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SSE] Flush to Neon failed:', err);
  } finally {
    client.release();
    isFlushing = false;
  }
}

/**
 * Registers an active client connection into our streaming pool
 * and replays the most recent feed history events
 */
export const registerSseClient = (res: Response) => {
  // Replay cached history to the new client
  for (const entry of feedHistory) {
    const payload = `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
    res.write(payload);
  }

  clients.push(res);
  
  // Clean up references when a client closes their browser tab
  res.on('close', () => {
    clients = clients.filter(client => client !== res);
  });
};

/**
 * Broadcasts an atomic data payload out to all connected listeners instantly
 * and stores it in the feed history cache
 */
export const broadcastSseEvent = (event: string, data: any) => {
  // Store in circular cache
  feedHistory.push({ event, data, timestamp: new Date() });
  if (feedHistory.length > MAX_HISTORY) feedHistory.shift();

  // Broadcast to all connected clients
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(payload);
  });

  // Activity detected: reset idle counter and timer for Neon persistence
  idleFlushCount = 0;
  resetIdleTimer();
};
