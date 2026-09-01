import { Response } from 'express';
import pool from './db.js';
import { getFeedHistory, appendFeed } from '../cache/appStore.js';

// Memory array to keep track of active HTTP response streams
let clients: Response[] = [];

// Heartbeat cada 20s: mantiene vivas las conexiones SSE a través de proxies.
// NO toca Neon (solo escribe una línea de comentario en el stream HTTP).
const HEARTBEAT_MS = 20 * 1000;

// Idle flush de feed_history a Neon (write-behind, no bloquea la UI)
const BASE_IDLE_FLUSH_MS = 5 * 60 * 1000; // 5 minutes base
const IDLE_INCREMENT_MS = 2 * 60 * 1000;  // +2 minutes each consecutive idle
let idleFlushCount = 0;                    // increments after each flush

let idleTimer: NodeJS.Timeout | null = null;
let isFlushing = false;

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
 * Flushes the in-memory feed cache (appStore) to Neon (called when server is idle)
 */
async function flushToNeon(): Promise<void> {
  const feedHistory = getFeedHistory();
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
 * and replays the most recent feed history events (from RAM store)
 */
export const registerSseClient = (res: Response) => {
  // Replay cached history to the new client (desde el store en RAM, sin BD)
  for (const entry of getFeedHistory()) {
    const payload = `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
    res.write(payload);
  }

  clients.push(res);

  // Heartbeat: evita que proxies corten la conexión ociosa. No toca Neon.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  // Clean up references when a client closes their browser tab
  res.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(client => client !== res);
  });
};

/**
 * Broadcasts an atomic data payload out to all connected listeners instantly
 * and stores it in the feed history cache (RAM)
 */
export const broadcastSseEvent = (event: string, data: any) => {
  // Store in circular cache (RAM)
  appendFeed(event, data);

  // Broadcast to all connected clients
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    client.write(payload);
  });

  // Activity detected: reset idle counter and timer for Neon persistence
  idleFlushCount = 0;
  resetIdleTimer();
};
