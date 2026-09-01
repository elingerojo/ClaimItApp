/**
 * backend/src/cache/appStore.ts
 *
 * Store de lectura en RAM (única fuente para GET /api/items, /api/ledger y el
 * historial de feeds). Se rehidrata desde Neon al arrancar de Railway.
 *
 * Write-through: cada writer de Neon actualiza el store en el mismo `await`.
 * Lecturas: nunca tocan la BD (solo RAM).
 * Sin sondeo periódico ni heartbeat hacia Neon: con cero tráfico el compute
 * de Neon puede autosuspenderse (no gasta "compute allowance" en inactividad).
 *
 * Válido porque hay UNA sola instancia de Railway (replicas=1).
 */

import pool from '../config/db.js';

export interface StoreItem {
  id: string;
  title: string;
  description: string | null;
  category: string;
  infoUrl: string | null;
  imageUrl: string;
  status: string;
  visibilityLevel: number | null;
  eventId: string | null;
  createdAt: string;
  queue: Array<{ userUuid: string; username: string; claimedAt: string }>;
}

export interface LedgerEntry {
  user_uuid: string;
  username: string;
  claimed_at: string;
  title: string;
  category: string;
}

export interface FeedEntry {
  event: string;
  data: any;
  timestamp: Date;
}

export interface StoreUser {
  uuid: string;
  alias: string;
  global_role: string;
}

export const MAX_FEED_HISTORY = 50;
export const MAX_LEDGER = 50;

// --- Estado en memoria (única instancia del proceso) ---
let items: StoreItem[] = [];
let ledger: LedgerEntry[] = [];
let feedHistory: FeedEntry[] = [];
let users: Map<string, StoreUser> = new Map();

/** Carga todo desde Neon al arrancar. Único acceso a BD en frío. */
export async function rehydrateAll(): Promise<void> {
  try {
    // 1. Items + claims (queues)
    const itemsResult = await pool.query('SELECT * FROM items ORDER BY created_at DESC');
    const claimsResult = await pool.query(
      `SELECT c.item_id, c.user_uuid, u.alias AS username, c.claimed_at
       FROM claims c JOIN users u ON c.user_uuid = u.uuid
       ORDER BY c.claimed_at ASC`
    );

    const claimsMap: Record<string, Array<{ userUuid: string; username: string; claimedAt: string }>> = {};
    claimsResult.rows.forEach((row: any) => {
      if (!claimsMap[row.item_id]) claimsMap[row.item_id] = [];
      claimsMap[row.item_id].push({
        userUuid: row.user_uuid,
        username: row.username,
        claimedAt: row.claimed_at
      });
    });

    items = itemsResult.rows.map((item: any) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      category: item.category,
      infoUrl: item.info_url,
      imageUrl: item.image_url,
      status: item.status,
      visibilityLevel: item.visibility_level,
      eventId: item.event_id,
      createdAt: item.created_at,
      queue: claimsMap[item.id] || []
    }));

    // 2. Ledger (últimas 50)
    const ledgerResult = await pool.query(
      `SELECT c.user_uuid, u.alias AS username, c.claimed_at, i.title, i.category
       FROM claims c
       JOIN items i ON c.item_id = i.id
       JOIN users u ON c.user_uuid = u.uuid
       ORDER BY c.claimed_at DESC
       LIMIT $1`,
      [MAX_LEDGER]
    );
    ledger = ledgerResult.rows;

    // 3. Feed history (últimas 50, cronológico ascendente)
    const feedResult = await pool.query(
      `SELECT event_name, event_data, created_at FROM feed_history ORDER BY created_at DESC LIMIT $1`,
      [MAX_FEED_HISTORY]
    );
    feedHistory = feedResult.rows.reverse().map((row: any) => ({
      event: row.event_name,
      data: row.event_data,
      timestamp: row.created_at
    }));

    // 4. Usuarios (alias + roles) para filtrado por rol en memoria
    const usersResult = await pool.query('SELECT uuid, alias, global_role FROM users');
    users = new Map(
      usersResult.rows.map((u: any) => [
        u.uuid,
        { uuid: u.uuid, alias: u.alias, global_role: u.global_role }
      ])
    );

    console.log(
      `[APPSTORE] Rehydrated: ${items.length} items, ${ledger.length} ledger, ${feedHistory.length} feeds, ${users.size} users`
    );
  } catch (err) {
    console.error('[APPSTORE] Rehydrate failed:', err);
  }
}

// --- Lecturas (sin BD) ---
export const getItems = (): StoreItem[] => items;
export const getLedger = (): LedgerEntry[] => ledger;
export const getFeedHistory = (): FeedEntry[] => feedHistory;
export const getUser = (uuid: string): StoreUser | undefined => users.get(uuid);

// --- Escrituras (write-through, llamadas por los controladores) ---
export function upsertItem(item: StoreItem): void {
  const idx = items.findIndex(i => i.id === item.id);
  if (idx >= 0) items[idx] = item;
  else items.unshift(item);
}

export function removeItem(itemId: string): void {
  items = items.filter(i => i.id !== itemId);
}

export function addClaimToItem(
  itemId: string,
  claim: { userUuid: string; username: string; claimedAt: string },
  newStatus: string
): void {
  items = items.map(i => {
    if (i.id !== itemId) return i;
    const queue = i.queue.some(q => q.userUuid === claim.userUuid)
      ? i.queue
      : [...i.queue, claim];
    return { ...i, status: newStatus, queue };
  });
}

export function removeClaimFromItem(itemId: string, userUuid: string, newStatus: string): void {
  items = items.map(i => {
    if (i.id !== itemId) return i;
    return { ...i, status: newStatus, queue: i.queue.filter(q => q.userUuid !== userUuid) };
  });
}

export function appendLedger(entry: LedgerEntry): void {
  ledger = [entry, ...ledger].slice(0, MAX_LEDGER);
}

export function appendFeed(event: string, data: any): void {
  feedHistory.push({ event, data, timestamp: new Date() });
  if (feedHistory.length > MAX_FEED_HISTORY) feedHistory.shift();
}

export function upsertUser(u: StoreUser): void {
  users.set(u.uuid, u);
}
