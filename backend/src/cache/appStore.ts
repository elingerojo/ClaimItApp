/**
 * backend/src/cache/appStore.ts — Store v2 en RAM (Estrategia temporal v2)
 *
 * Fuente de verdad del schema: `database/init.sql` + migraciones 0001..0004 y
 * el plan maestro `plans/estrategia-temporal-v2.md`.
 *
 * Es la única fuente para GET /api/items, /api/ledger, /api/items/:id/estado-
 * temporal y el historial de feeds. Se rehidrata desde Neon al arrancar.
 * Write-through: cada writer de Neon actualiza el store en el mismo `await`.
 * Lecturas: nunca tocan la BD (solo RAM).
 *
 * Cambios v2 (Fase 3):
 *  - `StoreItem` expone `phase` (ItemPhase), `frozen_schedule` (FrozenSchedule
 *    parseado), `frozen_at`, `free_window_opened_at`, `delivered_claim_id`,
 *    `delivered_at`, `charity_at` y la cola como `StoreClaim[]` (claim_state,
 *    role_at_claim, fifo_position, turn_v_expires_at). `status` se conserva
 *    como derivado legacy (lectura).
 *  - `StoreEvent` queda SOLO con las 4 fechas + status + pickup_schedule_info
 *    (cero columnas por rol: D8).
 *  - `StoreEventMember` ya no tiene `bonus_hours` (migración 0002): conserva
 *    `expiraciones_acumuladas` y `bloqueado_invitar`.
 */

import type {
  ClaimState,
  FifoPosition,
  FrozenSchedule,
  ItemPhase,
  ItemStatus,
  Role
} from '@claimitapp/shared';
import pool from '../config/db.js';

// ---------------------------------------------------------------------------
// Tipos v2 del store
// ---------------------------------------------------------------------------

/** Claim v2 en RAM — espejo de la tabla `claims` (registro forense). */
export interface StoreClaim {
  id: string;
  itemId: string;
  userUuid: string;
  /** Alias vigente del usuario (decorativo; no está denormalizado en la BD). */
  username: string | null;
  claimedAt: string;
  claimState: ClaimState;
  roleAtClaim: Role;
  fifoPosition: FifoPosition | null;
  turnVExpiresAt: string | null;
  claimantEmail: string | null;
  claimantPhone: string | null;
}

export interface StoreItem {
  id: string;
  eventId: string | null;
  title: string;
  description: string | null;
  category: string;
  infoUrl: string | null;
  /** Arreglo ordenado de URLs de fotos del Item (JSONB image_urls). */
  imageUrls: string[];
  /** status LEGACY/derivado (lectura para no romper el feed actual). */
  status: ItemStatus;
  /** Fase v2 (fuente de verdad del ciclo de vida). */
  phase: ItemPhase;
  visibilityLevel: number | null;
  // Precio base del item (fuente); el precio por rol se calcula en lectura.
  precioBaseCosto: number | null;
  // Snapshot congelado del calendario (jsonb parseado) o null si no congelado.
  frozenSchedule: FrozenSchedule | null;
  frozenAt: string | null;
  freeWindowOpenedAt: string | null;
  deliveredClaimId: string | null;
  deliveredAt: string | null;
  charityAt: string | null;
  createdAt: string;
  /** Cola completa del item (forense: incluye cancelados/expirados/void). */
  queue: StoreClaim[];
}

export interface StoreEvent {
  id: string;
  title: string | null;
  description?: string | null;
  available_from: string | null;
  published_at: string | null;
  claims_close_at: string | null;
  pickup_deadline: string | null;
  status: string;
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
  invitedBy: string | null;
  expiracionesAcumuladas: number;
  bloqueadoInvitar: boolean;
}

export const MAX_FEED_HISTORY = 50;
export const MAX_LEDGER = 50;

// --- Estado en memoria (única instancia del proceso) ---
let items: StoreItem[] = [];
let ledger: LedgerEntry[] = [];
let feedHistory: FeedEntry[] = [];
let users: Map<string, StoreUser> = new Map();
let events: Map<string, StoreEvent> = new Map();
let eventMembers: Map<string, StoreEventMember[]> = new Map(); // userUuid -> memberships
let trustSettings: Map<string, any> = new Map(); // level id -> trust_levels_settings row

// Índice por estatus de evento de los items (lazy). Ver getItemsByEventStatus.
let itemsByEventStatus: Map<string, StoreItem[]> | null = null;

let hydrated = false;
let hydrateInFlight: Promise<boolean> | null = null;
let lastHydrateAttemptAt = 0;
const HYDRATE_RETRY_COOLDOWN_MS = 15_000;

/**
 * Deriva el status LEGACY (`items.status`) desde la fase v2 + número de claims
 * activos. Se conserva solo como columna/lectura para no romper el contrato del
 * feed actual; el ciclo de vida v2 lo maneja `items.phase`.
 */
export function deriveLegacyStatus(
  phase: ItemPhase,
  activeCount: number
): ItemStatus {
  if (phase === 'claim_open') {
    if (activeCount >= 3) return 'unavailable';
    if (activeCount >= 1) return 'waitlist_open';
    return 'available';
  }
  // pickup_turns / ventana_libre / entregado / enviado_a_caridad ya no aceptan
  // unirse a la FIFO pública → legacy "unavailable".
  return 'unavailable';
}

/** Conteo de claims activos de una cola (estado 'active'). */
export function countActiveClaims(queue: StoreClaim[]): number {
  let n = 0;
  for (const c of queue) if (c.claimState === 'active') n++;
  return n;
}

/** Carga todo desde Neon al arrancar. Único acceso a BD en frío. */
export async function rehydrateAll(): Promise<boolean> {
  try {
    // 1. Items (columnas v2)
    const itemsResult = await pool.query(
      `SELECT id, event_id, title, description, category, info_url, image_urls,
              status, phase, visibility_level, precio_base_costo,
              frozen_schedule, frozen_at, free_window_opened_at,
              delivered_claim_id, delivered_at, charity_at, created_at
       FROM items ORDER BY created_at DESC`
    );

    // 2. Claims (sin username denormalizado en v2: se une a users para el alias)
    const claimsResult = await pool.query(
      `SELECT c.id, c.item_id, c.user_uuid, u.alias AS username, c.claimed_at,
              c.claim_state, c.role_at_claim, c.fifo_position,
              c.turn_v_expires_at, c.claimant_email, c.claimant_phone
       FROM claims c JOIN users u ON c.user_uuid = u.uuid
       ORDER BY c.claimed_at ASC, c.id ASC`
    );

    const claimsMap: Record<string, StoreClaim[]> = {};
    claimsResult.rows.forEach((row: any) => {
      const claim: StoreClaim = {
        id: row.id,
        itemId: row.item_id,
        userUuid: row.user_uuid,
        username: row.username ?? null,
        claimedAt: row.claimed_at,
        claimState: row.claim_state,
        roleAtClaim: (row.role_at_claim as Role) || 'publico',
        fifoPosition: row.fifo_position != null ? (Number(row.fifo_position) as FifoPosition) : null,
        turnVExpiresAt: row.turn_v_expires_at ?? null,
        claimantEmail: row.claimant_email ?? null,
        claimantPhone: row.claimant_phone ?? null
      };
      if (!claimsMap[claim.itemId]) claimsMap[claim.itemId] = [];
      claimsMap[claim.itemId].push(claim);
    });

    items = itemsResult.rows.map((item: any) => {
      const queue = claimsMap[item.id] || [];
      return {
        id: item.id,
        eventId: item.event_id ?? null,
        title: item.title,
        description: item.description,
        category: item.category,
        infoUrl: item.info_url,
        // pg devuelve el JSONB como arreglo JS ya parseado.
        imageUrls: Array.isArray(item.image_urls) ? item.image_urls : [],
        status: item.status,
        phase: item.phase,
        visibilityLevel: item.visibility_level,
        precioBaseCosto: item.precio_base_costo,
        frozenSchedule: item.frozen_schedule ? (item.frozen_schedule as FrozenSchedule) : null,
        frozenAt: item.frozen_at ?? null,
        freeWindowOpenedAt: item.free_window_opened_at ?? null,
        deliveredClaimId: item.delivered_claim_id ?? null,
        deliveredAt: item.delivered_at ?? null,
        charityAt: item.charity_at ?? null,
        createdAt: item.created_at,
        queue
      } as StoreItem;
    });

    // 3. Ledger (últimas 50, solo claims activos como actividad vigente)
    const ledgerResult = await pool.query(
      `SELECT c.user_uuid, u.alias AS username, c.claimed_at, i.title, i.category
       FROM claims c
       JOIN items i ON c.item_id = i.id
       JOIN users u ON c.user_uuid = u.uuid
       WHERE c.claim_state = 'active'
       ORDER BY c.claimed_at DESC
       LIMIT $1`,
      [MAX_LEDGER]
    );
    ledger = ledgerResult.rows;

    // 4. Feed history (últimas 50, cronológico ascendente)
    const feedResult = await pool.query(
      `SELECT event_name, event_data, created_at FROM feed_history ORDER BY created_at DESC LIMIT $1`,
      [MAX_FEED_HISTORY]
    );
    feedHistory = feedResult.rows.reverse().map((row: any) => ({
      event: row.event_name,
      data: row.event_data,
      timestamp: row.created_at
    }));

    // 5. Usuarios (alias + roles + blacklist)
    const usersResult = await pool.query(
      'SELECT uuid, alias, global_role, bloqueado_apartar FROM users'
    );
    users = new Map(
      usersResult.rows.map((u: any) => [
        u.uuid,
        { uuid: u.uuid, alias: u.alias, global_role: u.global_role, bloqueado_apartar: u.bloqueado_apartar }
      ])
    );

    // 6. Matriz de confianza v2 (advance pub/disp + precio + apartados)
    const trustResult = await pool.query(
      `SELECT id, advance_pub_hours_default, advance_disp_hours_default,
              multiplicador_precio_default, max_apartados_simultaneos, updated_at
       FROM trust_levels_settings`
    );
    trustSettings = new Map(trustResult.rows.map((r: any) => [r.id, r]));

    // 7. Eventos v2 (solo 4 fechas + status + nota)
    const eventsResult = await pool.query(
      `SELECT id, title, description, available_from, published_at,
              claims_close_at, pickup_deadline, status, pickup_schedule_info
       FROM events`
    );
    events = new Map(eventsResult.rows.map((e: any) => [e.id, e as StoreEvent]));

    // 8. Membresías v2 (sin role/bonus_hours)
    const membersResult = await pool.query(
      `SELECT event_id, user_uuid, invited_by, expiraciones_acumuladas, bloqueado_invitar
       FROM event_members`
    );
    eventMembers = new Map<string, StoreEventMember[]>();
    membersResult.rows.forEach((m: any) => {
      const list = eventMembers.get(m.user_uuid) || [];
      list.push({
        eventId: m.event_id,
        invitedBy: m.invited_by ?? null,
        expiracionesAcumuladas: Number(m.expiraciones_acumuladas) || 0,
        bloqueadoInvitar: !!m.bloqueado_invitar
      });
      eventMembers.set(m.user_uuid, list);
    });

    console.log(
      `[APPSTORE] Rehydrated v2: ${items.length} items, ${ledger.length} ledger, ${feedHistory.length} feeds, ${users.size} users, ${events.size} events, ${membersResult.rows.length} memberships`
    );
    // El store se reemplazó por completo: descartar el índice cacheado.
    itemsByEventStatus = null;
    hydrated = true;
    return true;
  } catch (err) {
    hydrated = false;
    console.error(
      '[APPSTORE] Rehydrate failed (store vacío; se reintentará en la próxima lectura):',
      err
    );
    return false;
  }
}

/** true cuando el store en RAM ya fue rehidratado correctamente desde Neon. */
export function isHydrated(): boolean {
  return hydrated;
}

/**
 * Self-heal perezoso del store: si el rehidratado de arranque falló, la primera
 * lectura que pase por aquí reintenta cargar todo (single-flight + cooldown).
 */
export function ensureHydrated(): Promise<void> {
  if (hydrated) return Promise.resolve();

  const now = Date.now();
  if (now - lastHydrateAttemptAt < HYDRATE_RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }
  lastHydrateAttemptAt = now;

  if (!hydrateInFlight) {
    hydrateInFlight = rehydrateAll().finally(() => {
      hydrateInFlight = null;
    });
  }
  return hydrateInFlight.then(() => undefined);
}

// --- Lecturas (sin BD) ---
export const getItems = (): StoreItem[] => items;
export const getItemById = (itemId: string): StoreItem | undefined =>
  items.find(i => i.id === itemId);
export const getLedger = (): LedgerEntry[] => ledger;
export const getFeedHistory = (): FeedEntry[] => feedHistory;
export const getUser = (uuid: string): StoreUser | undefined => users.get(uuid);
export const getEvent = (eventId: string): StoreEvent | undefined => events.get(eventId);
export const getEventMembership = (
  userUuid: string,
  eventId: string
): StoreEventMember | undefined =>
  (eventMembers.get(userUuid) || []).find(m => m.eventId === eventId);
export const getTrustSetting = (level: string): any => trustSettings.get(level);

/**
 * Write-through: aplica un parche a una fila de la matriz de confianza en RAM
 * (después del UPDATE en Neon). Hace merge conservando columnas no tocadas.
 */
export function upsertTrustSetting(levelId: string, patch: Record<string, any>): void {
  const prev = trustSettings.get(levelId) ?? {};
  trustSettings.set(levelId, { ...prev, ...patch, id: levelId });
}

// --- Escrituras (write-through, llamadas por los controladores/servicios) ---

function invalidateEventStatusIndex(): void {
  itemsByEventStatus = null;
}

/** Aplica un parche a un item en RAM y revalida el índice si cambió el evento. */
export function patchItem(itemId: string, patch: Partial<StoreItem>): void {
  const idx = items.findIndex(i => i.id === itemId);
  if (idx < 0) return;
  const prev = items[idx];
  const next = { ...prev, ...patch };
  // Sanidad: mantener la cola del item previo si el parche no la trae.
  if (!('queue' in patch) && !next.queue) next.queue = prev.queue || [];
  items[idx] = next;
  if (patch.eventId !== undefined && patch.eventId !== prev.eventId) {
    invalidateEventStatusIndex();
  }
}

/** Aplica un parche a un claim dentro de la cola de un item en RAM. */
export function patchClaim(
  itemId: string,
  claimId: string,
  patch: Partial<StoreClaim>
): void {
  const idx = items.findIndex(i => i.id === itemId);
  if (idx < 0) return;
  const item = items[idx];
  const cIdx = item.queue.findIndex(c => c.id === claimId);
  if (cIdx < 0) return;
  const queue = item.queue.slice();
  queue[cIdx] = { ...queue[cIdx], ...patch };
  items[idx] = { ...item, queue };
}

/** Inserta (o actualiza) un claim en la cola de un item en RAM. */
export function addClaimToItem(itemId: string, claim: StoreClaim): void {
  const idx = items.findIndex(i => i.id === itemId);
  if (idx < 0) return;
  const item = items[idx];
  const exists = item.queue.some(c => c.id === claim.id);
  const queue = exists ? item.queue.map(c => (c.id === claim.id ? claim : c)) : [...item.queue, claim];
  items[idx] = { ...item, queue };
}

/** Write-through de un item completo (create/update). */
export function upsertItem(item: StoreItem): void {
  const idx = items.findIndex(i => i.id === item.id);
  if (idx >= 0) items[idx] = item;
  else items.unshift(item);
  invalidateEventStatusIndex();
}

export function removeItem(itemId: string): void {
  items = items.filter(i => i.id !== itemId);
  invalidateEventStatusIndex();
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
 * ledger y mapa de usuarios. Devuelve los itemIds afectados.
 */
export function renameUserInStore(userUuid: string, newAlias: string): string[] {
  const affectedItemIds: string[] = [];

  items = items.map(i => {
    let changed = false;
    const queue = i.queue.map(c => {
      if (c.userUuid === userUuid && c.username !== newAlias) {
        changed = true;
        return { ...c, username: newAlias };
      }
      return c;
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

export function upsertEvent(evt: StoreEvent): void {
  events.set(evt.id, evt);
  invalidateEventStatusIndex();
}

/** Write-through del estatus de un evento en RAM. */
export function setEventStatusInStore(eventId: string, status: string): void {
  const evt = events.get(eventId);
  if (!evt) return;
  if (evt.status === status) return;
  events.set(eventId, { ...evt, status });
  invalidateEventStatusIndex();
}

export function removeEvent(eventId: string): void {
  events.delete(eventId);
  invalidateEventStatusIndex();
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

/** Desvincula todos los items del store de un evento eliminado. */
export function detachItemsFromEvent(eventId: string): void {
  items = items.map(i => {
    if (i.eventId !== eventId) return i;
    return { ...i, eventId: null };
  });
  invalidateEventStatusIndex();
}

// --- Índice por estatus de evento (lista admin) ---

/** Orden canónico de los estatus de evento. */
export const EVENT_STATUS_ORDER = ['draft', 'scheduled', 'active', 'closing', 'closed'] as const;

/** Clave interna del bucket "sin evento / huérfano" (defensivo). */
export const NO_EVENT_STATUS_KEY = '__no_event__';

/** Estatus de evento efectivo de un item según su eventId (o clave sin evento). */
function eventStatusOf(item: StoreItem): string {
  if (!item.eventId) return NO_EVENT_STATUS_KEY;
  const evt = events.get(item.eventId);
  return evt?.status ?? NO_EVENT_STATUS_KEY;
}

/** Barrido único: agrupa items por estatus de evento. */
function buildEventStatusIndex(): Map<string, StoreItem[]> {
  const index = new Map<string, StoreItem[]>();
  for (const item of items) {
    const key = eventStatusOf(item);
    const bucket = index.get(key);
    if (bucket) bucket.push(item);
    else index.set(key, [item]);
  }
  return index;
}

function ensureEventStatusIndex(): Map<string, StoreItem[]> {
  if (!itemsByEventStatus) itemsByEventStatus = buildEventStatusIndex();
  return itemsByEventStatus;
}

/** Items de los buckets pedidos (concatenación, orden de carga). */
export function getItemsByEventStatus(statuses: string[], includeNoEvent = true): StoreItem[] {
  const index = ensureEventStatusIndex();
  const out: StoreItem[] = [];
  const seen = new Set<string>();
  for (const status of statuses) {
    if (seen.has(status)) continue;
    seen.add(status);
    const bucket = index.get(status);
    if (bucket) out.push(...bucket);
  }
  if (includeNoEvent) {
    const noEvent = index.get(NO_EVENT_STATUS_KEY);
    if (noEvent) out.push(...noEvent);
  }
  return out;
}

/** Conteos por estatus canónico (para chips, incluso estatus no activos). */
export function getEventStatusCounts(): Record<string, number> {
  const index = ensureEventStatusIndex();
  const counts: Record<string, number> = {};
  for (const status of EVENT_STATUS_ORDER) {
    counts[status] = index.get(status)?.length ?? 0;
  }
  return counts;
}
