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
  visibleAt: string | null;
  availableFrom: string | null;
  expiresAt: string | null;
  // Trust-matrix price snapshot (frozen at creation)
  precioBaseCosto: number | null;
  precioFamiliar: number | null;
  precioAmigo: number | null;
  precioConocido: number | null;
  precioPublico: number | null;
  horasRecoleccionFamiliar: number | null;
  horasRecoleccionAmigo: number | null;
  horasRecoleccionConocido: number | null;
  horasRecoleccionPublico: number | null;
  nivelAccesoMinimo: string | null;
  createdAt: string;
  queue: Array<{
    userUuid: string;
    username: string;
    claimedAt: string;
    pickupDeadline: string | null;
    roleAtAssignment?: string | null;
    pickupWindowHours?: number | null;
  }>;
}

export interface StoreEvent {
  id: string;
  owner_uuid?: string;
  title?: string;
  available_from: string | null;
  published_at: string | null;
  status: string;
  pickup_deadline: string | null;
  claims_close_at: string | null;
  pickup_window_hours: number | null;
  familiares_advance_hours: number;
  amigos_advance_hours: number;
  conocidos_advance_hours: number;
  publico_advance_hours: number;
  familiares_pickup_hours: number | null;
  amigos_pickup_hours: number | null;
  conocidos_pickup_hours: number | null;
  publico_pickup_hours: number | null;
  pickup_schedule_info?: string | null;
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
  bloqueado_apartar?: boolean;
}

export interface StoreEventMember {
  eventId: string;
  role: string;
  bonusHours: number;
  invitedBy: string | null;
  bloqueadoInvitar?: boolean;
}

export const MAX_FEED_HISTORY = 50;
export const MAX_LEDGER = 50;

// --- Estado en memoria (única instancia del proceso) ---
let items: StoreItem[] = [];
let ledger: LedgerEntry[] = [];
let feedHistory: FeedEntry[] = [];
let users: Map<string, StoreUser> = new Map();
let events: Map<string, any> = new Map();
let eventMembers: Map<string, StoreEventMember[]> = new Map(); // userUuid -> memberships
let trustSettings: Map<string, any> = new Map(); // level id -> trust_levels_settings row

/** Carga todo desde Neon al arrancar. Único acceso a BD en frío. */
export async function rehydrateAll(): Promise<void> {
  try {
    // 1. Items + claims (queues)
    const itemsResult = await pool.query('SELECT * FROM items ORDER BY created_at DESC');
    const claimsResult = await pool.query(
      `SELECT c.item_id, c.user_uuid, u.alias AS username, c.claimed_at,
              c.pickup_deadline, c.role_at_assignment, c.pickup_window_hours
       FROM claims c JOIN users u ON c.user_uuid = u.uuid
       ORDER BY c.claimed_at ASC`
    );

    const claimsMap: Record<
      string,
      Array<{
        userUuid: string;
        username: string;
        claimedAt: string;
        pickupDeadline: string | null;
        roleAtAssignment: string | null;
        pickupWindowHours: number | null;
      }>
    > = {};
    claimsResult.rows.forEach((row: any) => {
      if (!claimsMap[row.item_id]) claimsMap[row.item_id] = [];
      claimsMap[row.item_id].push({
        userUuid: row.user_uuid,
        username: row.username,
        claimedAt: row.claimed_at,
        pickupDeadline: row.pickup_deadline,
        roleAtAssignment: row.role_at_assignment ?? null,
        pickupWindowHours: row.pickup_window_hours != null ? Number(row.pickup_window_hours) : null
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
      visibleAt: item.visible_at,
      availableFrom: item.available_from,
      expiresAt: item.expires_at,
      precioBaseCosto: item.precio_base_costo,
      precioFamiliar: item.precio_familiar,
      precioAmigo: item.precio_amigo,
      precioConocido: item.precio_conocido,
      precioPublico: item.precio_publico,
      horasRecoleccionFamiliar: item.horas_recoleccion_familiar,
      horasRecoleccionAmigo: item.horas_recoleccion_amigo,
      horasRecoleccionConocido: item.horas_recoleccion_conocido,
      horasRecoleccionPublico: item.horas_recoleccion_publico,
      nivelAccesoMinimo: item.nivel_acceso_minimo,
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

    // 4. Usuarios (alias + roles + blacklist) para filtrado por rol en memoria
    const usersResult = await pool.query(
      'SELECT uuid, alias, global_role, bloqueado_apartar FROM users'
    );
    users = new Map(
      usersResult.rows.map((u: any) => [
        u.uuid,
        { uuid: u.uuid, alias: u.alias, global_role: u.global_role, bloqueado_apartar: u.bloqueado_apartar }
      ])
    );

    // 5. Trust level settings (pricing multipliers / limits)
    const trustResult = await pool.query('SELECT * FROM trust_levels_settings');
    trustSettings = new Map(trustResult.rows.map((r: any) => [r.id, r]));

    // 6. Eventos + membresías para calcular disponibilidad efectiva en RAM
    const eventsResult = await pool.query(
      `SELECT id, title, available_from, published_at, status, pickup_deadline,
              claims_close_at, pickup_window_hours,
              familiares_advance_hours, amigos_advance_hours,
              conocidos_advance_hours, publico_advance_hours,
              familiares_pickup_hours, amigos_pickup_hours,
              conocidos_pickup_hours, publico_pickup_hours,
              pickup_schedule_info
       FROM events`
    );
    events = new Map(eventsResult.rows.map((e: any) => [e.id, e]));

    const membersResult = await pool.query(
      `SELECT event_id, user_uuid, role, bonus_hours, invited_by, bloqueado_invitar
       FROM event_members`
    );
    eventMembers = new Map<string, StoreEventMember[]>();
    membersResult.rows.forEach((m: any) => {
      const list = eventMembers.get(m.user_uuid) || [];
      list.push({
        eventId: m.event_id,
        role: m.role,
        bonusHours: m.bonus_hours,
        invitedBy: m.invited_by,
        bloqueadoInvitar: m.bloqueado_invitar
      });
      eventMembers.set(m.user_uuid, list);
    });

    console.log(
      `[APPSTORE] Rehydrated: ${items.length} items, ${ledger.length} ledger, ${feedHistory.length} feeds, ${users.size} users, ${events.size} events, ${membersResult.rows.length} memberships`
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
export const getEvent = (eventId: string): any => events.get(eventId);
export const getEventMembership = (
  userUuid: string,
  eventId: string
): StoreEventMember | undefined =>
  (eventMembers.get(userUuid) || []).find(m => m.eventId === eventId);
export const getTrustSetting = (level: string): any => trustSettings.get(level);

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
  claim: {
    userUuid: string;
    username: string;
    claimedAt: string;
    pickupDeadline: string | null;
    roleAtAssignment?: string | null;
    pickupWindowHours?: number | null;
  },
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

/**
 * Write-through: refresh the frozen deadline / role / window of a specific
 * queue entry (typically the new first-in-line after an advance). Keeps the
 * RAM store consistent with the frozen values persisted in Neon.
 */
export function refreshClaimDeadline(
  itemId: string,
  userUuid: string,
  pickupDeadline: string | null,
  roleAtAssignment?: string | null,
  pickupWindowHours?: number | null
): void {
  items = items.map(i => {
    if (i.id !== itemId) return i;
    const queue = i.queue.map(q =>
      q.userUuid === userUuid
        ? {
            ...q,
            pickupDeadline,
            roleAtAssignment: roleAtAssignment ?? q.roleAtAssignment ?? null,
            pickupWindowHours: pickupWindowHours != null ? pickupWindowHours : q.pickupWindowHours ?? null
          }
        : q
    );
    return { ...i, queue };
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

/**
 * Renombra el alias de un usuario en todo el store en RAM: colas de items,
 * ledger y mapa de usuarios. Es el write-through del UPDATE de alias en Neon.
 * Devuelve los itemIds donde el usuario tiene un claim (por si el emisor quiere
 * notificar por SSE por item), aunque el broadcast suele ser un evento único.
 */
export function renameUserInStore(userUuid: string, newAlias: string): string[] {
  const affectedItemIds: string[] = [];

  items = items.map(i => {
    let changed = false;
    const queue = i.queue.map(q => {
      if (q.userUuid === userUuid && q.username !== newAlias) {
        changed = true;
        return { ...q, username: newAlias };
      }
      return q;
    });
    if (changed) {
      affectedItemIds.push(i.id);
      return { ...i, queue };
    }
    return i;
  });

  ledger = ledger.map(l =>
    l.user_uuid === userUuid && l.username !== newAlias ? { ...l, username: newAlias } : l
  );

  const u = users.get(userUuid);
  if (u) users.set(userUuid, { ...u, alias: newAlias });

  return affectedItemIds;
}

export function upsertEvent(evt: any): void {
  events.set(evt.id, evt);
}

export function removeEvent(eventId: string): void {
  events.delete(eventId);
  // Also drop memberships pointing to the removed event
  for (const [userUuid, members] of eventMembers) {
    const filtered = members.filter(m => m.eventId !== eventId);
    if (filtered.length === 0) eventMembers.delete(userUuid);
    else eventMembers.set(userUuid, filtered);
  }
}

export function upsertEventMember(userUuid: string, membership: StoreEventMember): void {
  const list = eventMembers.get(userUuid) || [];
  const idx = list.findIndex(m => m.eventId === membership.eventId);
  if (idx >= 0) list[idx] = membership;
  else list.push(membership);
  eventMembers.set(userUuid, list);
}

/**
 * Propagate event-level date changes to the store items that INHERIT them
 * (items with their own value keep the override — inheritance vs override).
 */
export function propagateEventDates(
  eventId: string,
  changes: { availableFrom?: string | null; visibleAt?: string | null }
): void {
  items = items.map(i => {
    if (i.eventId !== eventId) return i;
    const next = { ...i };
    if (changes.availableFrom !== undefined && next.availableFrom === null) {
      next.availableFrom = changes.availableFrom;
    }
    if (changes.visibleAt !== undefined && next.visibleAt === null) {
      next.visibleAt = changes.visibleAt;
    }
    return next;
  });
}

/** Detach all store items from a deleted event (clear inherited scheduling). */
export function detachItemsFromEvent(eventId: string): void {
  items = items.map(i => {
    if (i.eventId !== eventId) return i;
    return { ...i, eventId: null, visibleAt: null, availableFrom: null, expiresAt: null };
  });
}

/** (Re)assign an item to an event in the store (write-through for batch assign). */
export function setItemEvent(itemId: string, eventId: string | null): void {
  items = items.map(i => (i.id === itemId ? { ...i, eventId } : i));
}
