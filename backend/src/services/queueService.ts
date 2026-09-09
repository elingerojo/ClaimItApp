/**
 * backend/src/services/queueService.ts — MOTOR v2 (Estrategia temporal v2)
 *
 * Fuente de verdad: `plans/estrategia-temporal-v2.md` (§4 reglas deterministas)
 * y el motor puro de `shared/eventHelpers.ts`.
 *
 * Este módulo es la capa TRANSACCIONAL que opera contra el schema v2
 * (`database/init.sql` + migraciones 0001..0004):
 *
 *  - `freezeItemIfDue()`: congela la cola en T_inicio (claims_close_at) de forma
 *    IDEMPOTENTE (fase claim_open + `frozen_schedule IS NULL`), persiste el
 *    snapshot `items.frozen_schedule` (buildFrozenSchedule) y asigna
 *    `fifo_position` + `turn_v_expires_at` (V_N inmutable) a cada claim activo.
 *    Cola vacía ⇒ phase='ventana_libre' con free_window_opened_at=claims_close_at.
 *  - `applyDueTransitions()`: transiciones por reloj sobre un item congelado:
 *    expira claims con turn_v_expires_at<=now (marca expirado + sanción de
 *    confianza), avanza turno, abre ventana libre al agotarse posiciones activas
 *    y manda a caridad si now>=pickup_deadline. Idempotente (row-lock FOR UPDATE).
 *  - `evaluateItemTemporalState()` / `temporalStateFromStore()`: evaluación
 *    determinista READ-ONLY del estado actual (CLAIM_ABIERTO/TURNO_1..3/
 *    VENTANA_LIBRE/ENTREGADO/ENVIADO_A_CARIDAD) → `shared.ItemTemporalState`.
 *  - `claimItem()`: "Lo quiero" (FIFO claim_open) o captura directa de ventana
 *    libre (entrega inmediata, phase='entregado'). Maneja todos los gates.
 *  - `voluntarilyLeaveItem()`: cancelación activa "Ya no lo quiero" — dominó
 *    NEUTRO (sin sanción); abre ventana libre si se agotan posiciones activas.
 *  - `deliverItemByAdmin()`: el ADMIN marca 'item recogido' (phase='entregado',
 *    delivered_claim_id/delivered_at, cola conservada como forense; void a los
 *    demás activos; detiene workflows).
 *
 * Cada función es auto-contenida (abre su propia conexión + transacción) y hace
 * write-through a la RAM store en el mismo flujo. Opcionalmente aceptan un
 * `client` externo para ejecutarse dentro de la transacción del llamador.
 */

import pool from '../config/db.js';
import {
  buildFrozenSchedule,
  MAX_QUEUE_POSITIONS,
  resolveEffectiveRole,
  type ClaimState,
  type FifoPosition,
  type FrozenSchedule,
  type ItemPhase,
  type ItemStatus,
  type ItemTemporalState,
  type Role,
  type TemporalParticipant
} from '@claimitapp/shared';
import {
  addClaimToItem,
  deriveLegacyStatus,
  patchClaim,
  patchItem,
  type StoreClaim,
  type StoreEvent,
  type StoreItem
} from '../cache/appStore.js';
import { applyExpirationSanction, reduceExpirationCount } from './trustSanctions.js';

const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

type DbClient = any;

/** Ejecuta una función dentro de una transacción (auto-manage o reutilizando client). */
async function runTx<T>(
  fn: (client: DbClient) => Promise<T>,
  client?: DbClient
): Promise<T> {
  if (client) return fn(client); // el llamador gestiona BEGIN/COMMIT
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    c.release();
  }
}

const toMs = (v: string | Date | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
};

const nowIso = (): string => new Date().toISOString();

function secondsUntil(deadlineMs: number | null, nowMs: number): number | null {
  if (deadlineMs === null) return null;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

interface ItemEventRow {
  id: string;
  phase: ItemPhase;
  event_id: string | null;
  event_status: string | null;
  claims_close_at: string | null;
  pickup_deadline: string | null;
  free_window_opened_at: string | null;
  delivered_at: string | null;
  charity_at: string | null;
  delivered_claim_id: string | null;
  event_published_at: string | null;
  event_available_from: string | null;
  status: string;
}

/**
 * Lock + lectura del item con su evento (debe correrse dentro de una tx).
 *
 * NOTA (bug REAL corregido en Fase 5 de verificación E2E): con `FOR UPDATE`
 * sobre un `LEFT JOIN`, PostgreSQL lanza `0A000: FOR UPDATE cannot be applied
 * to the nullable side of an outer join` y TODA operación del motor v2 fallaba
 * en runtime contra el schema v2 (items.event_id es NOT NULL → el lado derecho
 * del LEFT JOIN nunca es null, pero PG no puede probarlo). El lock que se
 * necesita es el de la fila del item (guarda de idempotencia / serialización
 * por item), así que se fija con `FOR UPDATE OF i` (permitido sobre el lado no
 * nullable del outer join) conservando el LEFT JOIN defensivo.
 */
async function lockItemWithEvent(itemId: string, client: DbClient): Promise<ItemEventRow | null> {
  const res = await client.query(
    `SELECT i.id, i.phase, i.event_id, i.status,
            i.free_window_opened_at, i.delivered_at, i.charity_at, i.delivered_claim_id,
            e.status AS event_status, e.published_at AS event_published_at,
            e.available_from AS event_available_from,
            e.claims_close_at, e.pickup_deadline
     FROM items i
     LEFT JOIN events e ON i.event_id = e.id
     WHERE i.id = $1
     FOR UPDATE OF i`,
    [itemId]
  );
  return res.rows.length > 0 ? (res.rows[0] as ItemEventRow) : null;
}

/** Claims ACTIVOS de un item ordenados por fifo_position (nulls last) y luego claimed_at. */
async function activeClaimsOfItem(itemId: string, client: DbClient): Promise<any[]> {
  const res = await client.query(
    `SELECT c.id, c.user_uuid, c.role_at_claim, c.fifo_position, c.turn_v_expires_at,
            u.alias AS username, c.claimed_at
     FROM claims c
     JOIN users u ON c.user_uuid = u.uuid
     WHERE c.item_id = $1 AND c.claim_state = 'active'
     ORDER BY c.fifo_position ASC NULLS LAST, c.claimed_at ASC, c.id ASC`,
    [itemId]
  );
  return res.rows;
}

function roleOrDefault(role: string | null | undefined): Role {
  return (role as Role) || 'publico';
}

/**
 * Convierte una fila de claim de BD a un StoreClaim (write-through a RAM).
 */
function toStoreClaim(row: any): StoreClaim {
  return {
    id: row.id,
    itemId: row.item_id,
    userUuid: row.user_uuid,
    username: row.username ?? null,
    claimedAt: row.claimed_at,
    claimState: (row.claim_state as ClaimState) || 'active',
    roleAtClaim: roleOrDefault(row.role_at_claim),
    fifoPosition: row.fifo_position != null ? (Number(row.fifo_position) as FifoPosition) : null,
    turnVExpiresAt: row.turn_v_expires_at ?? null,
    claimantEmail: row.claimant_email ?? null,
    claimantPhone: row.claimant_phone ?? null
  };
}

// ---------------------------------------------------------------------------
// 1. Congelamiento de la cola en T_inicio (idempotente)
// ---------------------------------------------------------------------------

export interface ItemFreezeResult {
  itemId: string;
  frozen: boolean;
  phase: ItemPhase;
  frozenAt: string | null;
  frozenSchedule: FrozenSchedule | null;
  queueCount: number;
  assignedClaims: Array<{ claimId: string; fifoPosition: FifoPosition; vExpiresAt: string | null }>;
}

/**
 * Congela la cola de un item si su phase='claim_open' y ya llegó claims_close_at
 * (T_inicio). Idempotente: si ya está congelado o en fase terminal no hace nada.
 * Persiste `frozen_schedule` (buildFrozenSchedule), asigna fifo_position y
 * turn_v_expires_at a los claims activos (máx 3) y pasa a pickup_turns (o
 * ventana_libre si la cola está vacía, con free_window_opened_at=claims_close_at).
 */
export async function freezeItemIfDue(itemId: string, client?: DbClient): Promise<ItemFreezeResult> {
  return runTx(async (c) => {
    const row = await lockItemWithEvent(itemId, c);
    if (!row) return { itemId, frozen: false, phase: 'claim_open', frozenAt: null, frozenSchedule: null, queueCount: 0, assignedClaims: [] };
    if (row.phase !== 'claim_open') {
      // Ya congelado / entregado / caridad / ventana libre: no se re-congela.
      return { itemId, frozen: false, phase: row.phase, frozenAt: null, frozenSchedule: null, queueCount: 0, assignedClaims: [] };
    }
    const nowMs = Date.now();
    const tInicioMs = toMs(row.claims_close_at);
    const tFinalMs = toMs(row.pickup_deadline);
    if (tInicioMs === null || tFinalMs === null || nowMs < tInicioMs || tFinalMs <= tInicioMs) {
      // Aún no llega T_inicio o faltan fechas del contenedor: no se congela.
      return { itemId, frozen: false, phase: row.phase, frozenAt: null, frozenSchedule: null, queueCount: 0, assignedClaims: [] };
    }

    const active = await activeClaimsOfItem(itemId, c);
    const queue = active.slice(0, MAX_QUEUE_POSITIONS).map((r: any) => ({
      role: roleOrDefault(r.role_at_claim),
      claimId: r.id
    }));

    const frozen = buildFrozenSchedule({
      frozenAt: nowIso(),
      claimsCloseAt: row.claims_close_at!,
      pickupDeadline: row.pickup_deadline!,
      queue
    });

    // Asignar posición + V_N (inmutable) a cada claim activo capturado.
    const assignedClaims: ItemFreezeResult['assignedClaims'] = [];
    for (let i = 0; i < queue.length; i++) {
      const claimId = queue[i].claimId;
      const position = (i + 1) as FifoPosition;
      const vExpires = [frozen.v1, frozen.v2, frozen.v3][i] ?? null;
      await c.query(
        `UPDATE claims SET fifo_position = $2, turn_v_expires_at = $3, updated_at = NOW()
         WHERE id = $1 AND claim_state = 'active'`,
        [claimId, position, vExpires]
      );
      assignedClaims.push({ claimId, fifoPosition: position, vExpiresAt: vExpires });
    }

    const phase: ItemPhase = queue.length === 0 ? 'ventana_libre' : 'pickup_turns';
    const freeWindowOpenedAt = queue.length === 0 ? new Date(tInicioMs).toISOString() : null;
    const legacyStatus = deriveLegacyStatus(phase, queue.length);

    const upd = await c.query(
      `UPDATE items
       SET phase = $2, frozen_schedule = $3::jsonb, frozen_at = $4,
           free_window_opened_at = $5, status = $6, updated_at = NOW()
       WHERE id = $1 AND frozen_schedule IS NULL AND phase = 'claim_open'
       RETURNING id`,
      [
        itemId,
        phase,
        JSON.stringify(frozen),
        nowIso(),
        freeWindowOpenedAt,
        legacyStatus
      ]
    );
    if (upd.rows.length === 0) {
      // Otro writer lo congeló primero en la ventana de carrera (el lock lo evita,
      // pero la guarda es la red de seguridad idempotente).
      return { itemId, frozen: false, phase, frozenAt: null, frozenSchedule: null, queueCount: queue.length, assignedClaims: [] };
    }

    // Write-through a RAM (después del COMMIT se aplica abajo, pero el patch se
    // puede hacer ya: las lecturas en RAM que ocurran antes del commit son
    // irrelevantes porque el store es de solo lectura entre operaciones).
    patchItem(itemId, {
      phase,
      frozenSchedule: frozen,
      frozenAt: nowIso(),
      freeWindowOpenedAt,
      status: legacyStatus
    });
    for (const a of assignedClaims) {
      patchClaim(itemId, a.claimId, { fifoPosition: a.fifoPosition, turnVExpiresAt: a.vExpiresAt });
    }

    return {
      itemId,
      frozen: true,
      phase,
      frozenAt: nowIso(),
      frozenSchedule: frozen,
      queueCount: queue.length,
      assignedClaims
    };
  }, client);
}

// ---------------------------------------------------------------------------
// 2. Evaluador determinista del estado temporal (READ-ONLY)
// ---------------------------------------------------------------------------

export interface TemporalEvalItem {
  phase: ItemPhase;
  frozenSchedule: FrozenSchedule | null;
  freeWindowOpenedAt: string | null;
  deliveredAt: string | null;
  charityAt: string | null;
  deliveredClaimId: string | null;
}

export interface TemporalEvalEvent {
  claimsCloseAt: string | null;
  availableFrom: string | null;
  publishedAt: string | null;
  pickupDeadline: string | null;
}

export interface TemporalEvalClaim {
  id: string;
  userUuid: string;
  username: string | null;
  claimState: ClaimState;
  roleAtClaim: Role | null;
  fifoPosition: FifoPosition | null;
  turnVExpiresAt: string | null;
  claimedAt: string | null;
}

export interface TemporalEvalInput {
  item: TemporalEvalItem;
  event: TemporalEvalEvent | null;
  claims: TemporalEvalClaim[];
  now?: Date | number | string;
}

function positionRank(pos: FifoPosition | null): number {
  return pos === null ? Number.MAX_SAFE_INTEGER : pos;
}

/** Ordena participantes para el payload: posición FIFO asc (nulls al final) → claimed_at asc. */
export function sortParticipants(claims: TemporalEvalClaim[]): TemporalEvalClaim[] {
  return claims.slice().sort((a, b) => {
    const byPos = positionRank(a.fifoPosition) - positionRank(b.fifoPosition);
    if (byPos !== 0) return byPos;
    const aT = toMs(a.claimedAt) ?? 0;
    const bT = toMs(b.claimedAt) ?? 0;
    return aT - bT;
  });
}

/**
 * Evaluación DETERMINISTA y READ-ONLY del estado actual de un item a partir de
 * su fase + snapshot congelado + claims + reloj del evento. No toca la BD.
 * Asume que el llamador ya corrió el lazy catch-up (freeze + transiciones), de
 * modo que phase/frozen_schedule están al día.
 *
 * Códigos de `estado_actual`: CLAIM_ABIERTO | TURNO_1 | TURNO_2 | TURNO_3 |
 * VENTANA_LIBRE | ENTREGADO | ENVIADO_A_CARIDAD.
 */
export function evaluateItemTemporalState(input: TemporalEvalInput): ItemTemporalState {
  const nowMs =
    input.now == null
      ? Date.now()
      : typeof input.now === 'number'
        ? input.now
        : new Date(input.now).getTime();
  const { item, event, claims } = input;
  const frozen = item.frozenSchedule;

  const activeTurn = sortParticipants(
    claims.filter((c) => c.claimState === 'active')
  )[0] ?? null;

  let estado_actual: ItemTemporalState['estado_actual'];
  let seconds: number | null = null;

  switch (item.phase) {
    case 'claim_open': {
      estado_actual = 'CLAIM_ABIERTO';
      seconds = secondsUntil(toMs(event?.claimsCloseAt ?? null), nowMs);
      break;
    }
    case 'pickup_turns': {
      if (!activeTurn) {
        // Sin posiciones activas (todas canceladas/expiradas sin catch-up): la
        // ventana libre abre en cuanto corra la transición. Reportamos la ventana.
        estado_actual = 'VENTANA_LIBRE';
        seconds = secondsUntil(toMs(event?.pickupDeadline ?? null), nowMs);
      } else {
        const position = activeTurn.fifoPosition ?? 1;
        estado_actual = (position === 1 ? 'TURNO_1' : position === 2 ? 'TURNO_2' : 'TURNO_3');
        seconds = secondsUntil(toMs(activeTurn.turnVExpiresAt), nowMs);
      }
      break;
    }
    case 'ventana_libre': {
      estado_actual = 'VENTANA_LIBRE';
      seconds = secondsUntil(toMs(event?.pickupDeadline ?? null), nowMs);
      break;
    }
    case 'entregado':
      estado_actual = 'ENTREGADO';
      seconds = null;
      break;
    case 'enviado_a_caridad':
      estado_actual = 'ENVIADO_A_CARIDAD';
      seconds = null;
      break;
  }

  // Línea de tiempo fija (calendario congelado) o null si aún no se congela.
  let linea_tiempo_fija: ItemTemporalState['linea_tiempo_fija'] = null;
  if (frozen) {
    linea_tiempo_fija = {
      vencimiento_posicion_1: frozen.v1,
      vencimiento_posicion_2: frozen.v2,
      vencimiento_posicion_3: frozen.v3,
      ventana_libre: frozen.ventana_libre_starts_at,
      caridad_final: frozen.charity_at
    };
  } else if (item.phase !== 'claim_open' && event?.pickupDeadline) {
    // Terminales sin snapshot (defensivo): al menos la fecha de caridad.
    linea_tiempo_fija = {
      vencimiento_posicion_1: null,
      vencimiento_posicion_2: null,
      vencimiento_posicion_3: null,
      ventana_libre: item.freeWindowOpenedAt,
      caridad_final: event.pickupDeadline
    };
  }

  const participantes: TemporalParticipant[] = sortParticipants(claims).map((c) => ({
    claimId: c.id,
    userUuid: c.userUuid,
    username: c.username ?? null,
    claimState: c.claimState,
    roleAtClaim: c.roleAtClaim ?? null,
    fifoPosition: c.fifoPosition ?? null,
    turnVExpiresAt: c.turnVExpiresAt ?? null,
    claimedAt: c.claimedAt ?? null
  }));

  return {
    itemId: '',
    phase: item.phase,
    estado_actual,
    tiempo_restante_turno_activo_segundos: seconds,
    linea_tiempo_fija,
    participantes
  };
}

/** Conveniencia: itemId se rellena aquí (el evaluador puro lo deja vacío). */
export function temporalStateFromStore(item: StoreItem, event?: StoreEvent): ItemTemporalState {
  const state = evaluateItemTemporalState({
    item,
    event: event
      ? {
          claimsCloseAt: event.claims_close_at,
          availableFrom: event.available_from,
          publishedAt: event.published_at,
          pickupDeadline: event.pickup_deadline
        }
      : null,
    claims: item.queue
  });
  return { ...state, itemId: item.id };
}

// ---------------------------------------------------------------------------
// 3. Transiciones por reloj (expirio / avance / ventana libre / caridad)
// ---------------------------------------------------------------------------

export interface ExpiredTurnInfo {
  claimId: string;
  userUuid: string;
  username: string | null;
  role: Role;
  sanctioned: string; // 'none' | 'invite_blocked' | 'degraded' | 'blacklisted'
}

export interface ApplyTransitionsResult {
  itemId: string;
  changed: boolean;
  phase: ItemPhase;
  status: ItemStatus;
  expired: ExpiredTurnInfo[];
  freeWindowOpenedAt: string | null;
  charityAt: string | null;
  voidedCount: number;
  activeRemaining: number;
}

/**
 * Aplica las transiciones por reloj de un item congelado:
 *  - Expira los claims activos cuyo turn_v_expires_at <= now (en orden FIFO).
 *    Cada expirio marca claim_state='expirado' y dispara la sanción de
 *    confianza (trustSanctions). La siguiente posición activa hereda su V fijo.
 *  - Si en pickup_turns se agotan las posiciones activas → abre la ventana
 *    libre en este instante (free_window_opened_at = now).
 *  - Si now >= pickup_deadline (T_final) sin entrega → fase enviado_a_caridad
 *    (+ charity_at = now) y void de los claims activos restantes.
 * Idempotente: protegido por row-lock FOR UPDATE (solo el primer writer gana).
 */
export async function applyDueTransitions(
  itemId: string,
  client?: DbClient
): Promise<ApplyTransitionsResult> {
  return runTx(async (c) => {
    const empty: ApplyTransitionsResult = {
      itemId,
      changed: false,
      phase: 'claim_open',
      status: 'available',
      expired: [],
      freeWindowOpenedAt: null,
      charityAt: null,
      voidedCount: 0,
      activeRemaining: 0
    };

    const row = await lockItemWithEvent(itemId, c);
    if (!row) return { ...empty, phase: 'claim_open' };
    if (row.phase !== 'pickup_turns' && row.phase !== 'ventana_libre') {
      return { ...empty, phase: row.phase, status: row.status as ItemStatus };
    }

    const nowMs = Date.now();
    const tFinalMs = toMs(row.pickup_deadline);
    let phase: ItemPhase = row.phase;
    let freeWindowOpenedAt: string | null = row.free_window_opened_at ?? null;
    let charityAt: string | null = null;
    const expired: ExpiredTurnInfo[] = [];
    let voidedCount = 0;
    const eventId = row.event_id;

    const active = await activeClaimsOfItem(itemId, c);

    // --- Caridad: T_final alcanzado sin entrega (irrevocable) ---
    if (tFinalMs !== null && nowMs >= tFinalMs) {
      // NOTA (bug REAL corregido en Fase 5 de verificación E2E): `active` viene de
      // activeClaimsOfItem(), cuya SELECT NO incluye claim_state (filtra por
      // claim_state='active' en el WHERE). El guard `claim.claim_state === 'active'`
      // era siempre false → los claims activos restantes NUNCA pasaban a void y
      // quedaban activos apuntando a un item enviado_a_caridad. Se volean todos
      // los de `active` (por construcción son los activos) como registro forense.
      for (const claim of active) {
        await c.query(
          `UPDATE claims SET claim_state = 'void', updated_at = NOW() WHERE id = $1`,
          [claim.id]
        );
        voidedCount++;
      }
      phase = 'enviado_a_caridad';
      charityAt = nowIso();
      await c.query(
        `UPDATE items SET phase = $2, charity_at = $3, status = 'unavailable', updated_at = NOW()
         WHERE id = $1`,
        [itemId, phase, charityAt]
      );
      const status: ItemStatus = 'unavailable';
      patchItem(itemId, { phase, charityAt, status });
      for (const claim of active) patchClaim(itemId, claim.id, { claimState: 'void' });
      return { itemId, changed: true, phase, status, expired, freeWindowOpenedAt: null, charityAt, voidedCount, activeRemaining: 0 };
    }

    // --- Expirios por reloj (turn_v_expires_at <= now), en orden FIFO ---
    for (const claim of active) {
      const vMs = toMs(claim.turn_v_expires_at);
      if (vMs !== null && vMs <= nowMs) {
        await c.query(
          `UPDATE claims SET claim_state = 'expirado', updated_at = NOW() WHERE id = $1`,
          [claim.id]
        );
        let sanction = 'none';
        if (eventId) {
          const res = await applyExpirationSanction(eventId, claim.user_uuid, c);
          if (res) sanction = res.sanctioned;
        }
        expired.push({
          claimId: claim.id,
          userUuid: claim.user_uuid,
          username: claim.username ?? null,
          role: roleOrDefault(claim.role_at_claim),
          sanctioned: sanction
        });
      } else {
        // Primera posición activa con turno aún vigente: es el turno actual.
        break;
      }
    }

    if (expired.length > 0) {
      for (const e of expired) patchClaim(itemId, e.claimId, { claimState: 'expirado' });
    }

    // --- Recalcular posiciones activas tras expirios ---
    const after = await activeClaimsOfItem(itemId, c);

    // --- Si se agotan las posiciones activas en pickup_turns → ventana libre ---
    if (phase === 'pickup_turns' && after.length === 0) {
      phase = 'ventana_libre';
      freeWindowOpenedAt = nowIso();
    }

    const status = deriveLegacyStatus(phase, after.length);

    if (phase !== row.phase || freeWindowOpenedAt !== row.free_window_opened_at) {
      await c.query(
        `UPDATE items
         SET phase = $2, free_window_opened_at = $3, status = $4, updated_at = NOW()
         WHERE id = $1`,
        [itemId, phase, freeWindowOpenedAt, status]
      );
      patchItem(itemId, { phase, freeWindowOpenedAt, status });
    } else if (expired.length > 0) {
      // Solo hubo expirios: status derivado puede cambiar (unavailable→…).
      if (row.status !== status) {
        await c.query(`UPDATE items SET status = $2, updated_at = NOW() WHERE id = $1`, [
          itemId,
          status
        ]);
        patchItem(itemId, { status });
      }
    }

    return {
      itemId,
      changed: expired.length > 0 || phase !== row.phase || charityAt !== null,
      phase,
      status,
      expired,
      freeWindowOpenedAt: freeWindowOpenedAt !== row.free_window_opened_at ? freeWindowOpenedAt : null,
      charityAt,
      voidedCount,
      activeRemaining: after.length
    };
  }, client);
}

// ---------------------------------------------------------------------------
// 4. "Lo quiero" — FIFO (claim_open) o captura directa (ventana libre)
// ---------------------------------------------------------------------------

export type ClaimOutcome =
  | {
      ok: true;
      kind: 'fifo';
      claimId: string;
      claimedAt: string;
      fifoPosition: number;
      phase: ItemPhase;
      status: ItemStatus;
      eventId: string | null;
      title: string | null;
      category: string | null;
    }
  | {
      ok: true;
      kind: 'free_window_capture';
      claimId: string;
      claimedAt: string;
      deliveredClaimId: string;
      deliveredAt: string;
      phase: ItemPhase;
      status: ItemStatus;
      eventId: string | null;
      title: string | null;
      category: string | null;
    }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'blocked'
        | 'phase_not_open'
        | 'not_yet'
        | 'already_closed'
        | 'queue_full'
        | 'already_in_queue'
        | 'limit_exceeded'
        | 'event_closed'
        | 'event_not_published';
      message: string;
    };

export interface ClaimItemInput {
  itemId: string;
  userUuid: string;
  username: string;
  role: Role;
  email?: string | null;
  phone?: string | null;
}

/**
 * "Lo quiero":
 *  - phase='claim_open' y dentro de la ventana del rol → INSERT FIFO (hasta 3).
 *  - phase='ventana_libre' → captura directa: se inserta el claim y el item pasa
 *    a phase='entregado' con delivered_claim_id/delivered_at (entrega inmediata;
 *    no cuenta en max_apartados_simultaneos ni dispara sanción).
 * Rechaza si el item ya está congelado en pickup_turns (solo queda esperar la
 * ventana libre), entregado o enviado a caridad.
 */
export async function claimItem(
  input: ClaimItemInput,
  client?: DbClient
): Promise<ClaimOutcome> {
  const { itemId, userUuid, username, role, email, phone } = input;

  return runTx(async (c) => {
    // Bloqueado de apartar (respecta ventana libre y FIFO).
    const userRes = await c.query(
      'SELECT alias, bloqueado_apartar FROM users WHERE uuid = $1',
      [userUuid]
    );
    if (userRes.rows.length === 0) {
      return { ok: false, code: 'not_found', message: 'User not found.' } as ClaimOutcome;
    }
    const user = userRes.rows[0];
    const effectiveUsername = user.alias || username;

    // Bloqueado de apartar: aplica a FIFO y a ventana libre (sin excepción).
    if (user.bloqueado_apartar) {
      return {
        ok: false,
        code: 'blocked',
        message: 'Tu cuenta está bloqueada para nuevas separaciones por exceder el umbral de expiraciones.'
      } as ClaimOutcome;
    }

    // Rol vigente (fuente de verdad global; el rol del call-site es solo un hint).
    const roleRow = await c.query('SELECT global_role FROM users WHERE uuid = $1', [userUuid]);
    const roleAtClaim: Role = roleOrDefault(roleRow.rows[0]?.global_role ?? role);

    const row = await lockItemWithEvent(itemId, c);
    if (!row) return { ok: false, code: 'not_found', message: 'Item not found.' } as ClaimOutcome;

    // Regla v2 "evento como fuente única": evento sin publicar (published_at NULL)
    // no admite claims (nadie reclama antes de que el evento publique).
    if (!row.event_published_at) {
      return { ok: false, code: 'event_not_published', message: 'Este evento aún no está publicado.' } as ClaimOutcome;
    }

    // Ya tengo un claim activo en este item.
    const dup = await c.query(
      `SELECT id FROM claims WHERE item_id = $1 AND user_uuid = $2 AND claim_state = 'active' LIMIT 1`,
      [itemId, userUuid]
    );
    if (dup.rows.length > 0) {
      return { ok: false, code: 'already_in_queue', message: 'Ya estás en la lista de este objeto.' } as ClaimOutcome;
    }

    // Matriz de confianza: adelanto de disponibilidad + límite de apartados.
    const trust = await c.query(
      `SELECT advance_disp_hours_default, max_apartados_simultaneos
       FROM trust_levels_settings WHERE id = $1`,
      [roleAtClaim]
    );
    const advanceDispHours = Number(trust.rows[0]?.advance_disp_hours_default ?? 0);
    const maxApartados = Number(trust.rows[0]?.max_apartados_simultaneos ?? 1);

    const nowMs = Date.now();

    // ---------------------------------------------------------------
    // A) Ventana libre → captura directa (entrega inmediata)
    // ---------------------------------------------------------------
    if (row.phase === 'ventana_libre') {
      const tFinalMs = toMs(row.pickup_deadline);
      if (tFinalMs !== null && nowMs >= tFinalMs) {
        return { ok: false, code: 'already_closed', message: 'El objeto ya fue enviado a caridad.' } as ClaimOutcome;
      }

      const ins = await c.query(
        `INSERT INTO claims (item_id, user_uuid, claim_state, role_at_claim, claimant_email, claimant_phone, claimed_at)
         VALUES ($1, $2, 'active', $3, $4, $5, NOW())
         RETURNING id, claimed_at`,
        [itemId, userUuid, roleAtClaim, email || null, phone || null]
      );
      const claim = ins.rows[0];
      const deliveredAt = nowIso();

      // Void de cualquier otro claim activo (forense) + entrega al capturador.
      await c.query(
        `UPDATE claims SET claim_state = 'void', updated_at = NOW()
         WHERE item_id = $1 AND claim_state = 'active' AND id <> $2`,
        [itemId, claim.id]
      );
      await c.query(
        `UPDATE items
         SET phase = 'entregado', delivered_claim_id = $2, delivered_at = $3,
             status = 'unavailable', updated_at = NOW()
         WHERE id = $1`,
        [itemId, claim.id, deliveredAt]
      );

      // Write-through RAM.
      addClaimToItem(itemId, {
        id: claim.id,
        itemId,
        userUuid,
        username: effectiveUsername,
        claimedAt: claim.claimed_at,
        claimState: 'active',
        roleAtClaim,
        fifoPosition: null,
        turnVExpiresAt: null,
        claimantEmail: email || null,
        claimantPhone: phone || null
      });
      patchItem(itemId, { phase: 'entregado', deliveredClaimId: claim.id, deliveredAt, status: 'unavailable' });

      return {
        ok: true,
        kind: 'free_window_capture',
        claimId: claim.id,
        claimedAt: claim.claimed_at,
        deliveredClaimId: claim.id,
        deliveredAt,
        phase: 'entregado',
        status: 'unavailable',
        eventId: row.event_id,
        title: null,
        category: null
      } as ClaimOutcome;
    }

    // ---------------------------------------------------------------
    // B) FIFO — SOLO phase='claim_open'
    // ---------------------------------------------------------------
    if (row.phase !== 'claim_open') {
      if (row.phase === 'pickup_turns') {
        return {
          ok: false,
          code: 'phase_not_open',
          message: 'La lista de este objeto ya está cerrada; espera la ventana libre para reclamarlo.'
        } as ClaimOutcome;
      }
      return { ok: false, code: 'phase_not_open', message: 'Este objeto ya no acepta nuevos apartados.' } as ClaimOutcome;
    }

    // Gate de evento: status closed → no (defensivo; el reloj manda igual).
    if (row.event_status === 'closed') {
      return { ok: false, code: 'event_closed', message: 'El evento ya no acepta nuevas separaciones.' } as ClaimOutcome;
    }

    // Ventana por rol: now >= claim_from (event.available_from − advance_disp del rol).
    const baseAvailable = row.event_available_from;
    const claimFromMs = baseAvailable ? toMs(baseAvailable)! - advanceDispHours * HOUR_MS : null;
    if (claimFromMs !== null && nowMs < claimFromMs) {
      return { ok: false, code: 'not_yet', message: 'Este objeto aún no está disponible para tu rol (tu ventana abre más tarde).' } as ClaimOutcome;
    }

    // Cierre público de la FIFO: now < claims_close_at.
    const closeMs = toMs(row.claims_close_at);
    if (closeMs !== null && nowMs >= closeMs) {
      return { ok: false, code: 'already_closed', message: 'La lista de este objeto ya está cerrada.' } as ClaimOutcome;
    }

    // Límite de apartados simultáneos por rol dentro del evento.
    if (row.event_id) {
      const activeInEvent = await c.query(
        `SELECT COUNT(*)::int AS n
         FROM claims c JOIN items i ON c.item_id = i.id
         WHERE c.user_uuid = $1 AND c.claim_state = 'active' AND i.event_id = $2`,
        [userUuid, row.event_id]
      );
      if (activeInEvent.rows[0].n >= maxApartados) {
        return {
          ok: false,
          code: 'limit_exceeded',
          message: `Límite de apartados simultáneos alcanzado (máximo ${maxApartados} para tu rol en este evento).`
        } as ClaimOutcome;
      }
    }

    // Cola activa actual (máx 3).
    const activeCount = Number(
      (
        await c.query(
          `SELECT COUNT(*)::int AS n FROM claims WHERE item_id = $1 AND claim_state = 'active'`,
          [itemId]
        )
      ).rows[0].n
    );
    if (activeCount >= MAX_QUEUE_POSITIONS) {
      return { ok: false, code: 'queue_full', message: 'La lista de este objeto está completamente llena.' } as ClaimOutcome;
    }

    const ins = await c.query(
      `INSERT INTO claims (item_id, user_uuid, claim_state, role_at_claim, claimant_email, claimant_phone, claimed_at)
       VALUES ($1, $2, 'active', $3, $4, $5, NOW())
       RETURNING id, claimed_at`,
      [itemId, userUuid, roleAtClaim, email || null, phone || null]
    );
    const claim = ins.rows[0];
    const fifoPosition = activeCount + 1;
    const legacyStatus = deriveLegacyStatus('claim_open', fifoPosition);
    await c.query(`UPDATE items SET status = $2, updated_at = NOW() WHERE id = $1`, [
      itemId,
      legacyStatus
    ]);

    // Write-through RAM.
    addClaimToItem(itemId, {
      id: claim.id,
      itemId,
      userUuid,
      username: effectiveUsername,
      claimedAt: claim.claimed_at,
      claimState: 'active',
      roleAtClaim,
      fifoPosition: null, // se asigna al congelar en T_inicio
      turnVExpiresAt: null,
      claimantEmail: email || null,
      claimantPhone: phone || null
    });
    patchItem(itemId, { status: legacyStatus });

    return {
      ok: true,
      kind: 'fifo',
      claimId: claim.id,
      claimedAt: claim.claimed_at,
      fifoPosition,
      phase: 'claim_open',
      status: legacyStatus,
      eventId: row.event_id,
      title: null,
      category: null
    } as ClaimOutcome;
  }, client);
}

// ---------------------------------------------------------------------------
// 5. Cancelación activa "Ya no lo quiero" — dominó NEUTRO (sin sanción)
// ---------------------------------------------------------------------------

export type VoluntaryLeaveOutcome =
  | {
      ok: true;
      itemId: string;
      userUuid: string;
      username: string | null;
      claimState: ClaimState;
      phase: ItemPhase;
      status: ItemStatus;
      freeWindowOpenedAt: string | null;
      wasActiveHolder: boolean;
    }
  | { ok: false; code: 'no_active_claim' | 'already_delivered' | 'not_found'; message: string };

/**
 * Salida voluntaria del titular / miembro de la cola:
 *  - claim_open (pre-congelamiento): libera la posición (cancelado_voluntario,
 *    neutral). Cualquiera con claim activo puede salir.
 *  - pickup_turns: solo el TITULAR activo dispara el dominó; si no hay siguiente
 *    activo se abre la ventana libre en este instante. Un no-titular activo se
 *    marca cancelado_voluntario (neutral) y la cola se recompone sola (los V ya
 *    están fijos en el snapshot).
 *  - No se puede "dejar" un claim de un item ya entregado/enviado a caridad.
 * NUNCA aplica sanción (el expirio sí; la cancelación voluntaria es neutral).
 */
export async function voluntarilyLeaveItem(
  itemId: string,
  userUuid: string,
  client?: DbClient
): Promise<VoluntaryLeaveOutcome> {
  return runTx(async (c) => {
    const row = await lockItemWithEvent(itemId, c);
    if (!row) return { ok: false, code: 'not_found', message: 'Item not found.' };

    const claimRes = await c.query(
      `SELECT c.id, c.claim_state, c.fifo_position, c.turn_v_expires_at, u.alias AS username
       FROM claims c JOIN users u ON c.user_uuid = u.uuid
       WHERE c.item_id = $1 AND c.user_uuid = $2
       ORDER BY c.claimed_at DESC, c.id DESC
       LIMIT 1`,
      [itemId, userUuid]
    );
    const claim = claimRes.rows[0];
    if (!claim || claim.claim_state !== 'active') {
      return { ok: false, code: 'no_active_claim', message: 'No tienes un apartado activo en este objeto.' };
    }

    const username = claim.username ?? null;
    let phase = row.phase as ItemPhase;
    let freeWindowOpenedAt: string | null = row.free_window_opened_at ?? null;
    let wasActiveHolder = false;

    if (row.delivered_at || row.phase === 'entregado' || row.phase === 'enviado_a_caridad') {
      return { ok: false, code: 'already_delivered', message: 'Este objeto ya fue entregado; no puedes cancelar tu apartado.' };
    }

    if (row.phase === 'pickup_turns') {
      // ¿Soy el titular actual? = claim activo con la menor fifo_position.
      const firstActive = (
        await c.query(
          `SELECT id, fifo_position FROM claims
           WHERE item_id = $1 AND claim_state = 'active'
           ORDER BY fifo_position ASC NULLS LAST, claimed_at ASC, id ASC
           LIMIT 1`,
          [itemId]
        )
      ).rows[0];
      wasActiveHolder = firstActive?.id === claim.id;
    }

    await c.query(
      `UPDATE claims SET claim_state = 'cancelado_voluntario', updated_at = NOW() WHERE id = $1`,
      [claim.id]
    );
    patchClaim(itemId, claim.id, { claimState: 'cancelado_voluntario' });

    // Si era titular en pickup_turns y se agotaron los activos → ventana libre ya.
    if (row.phase === 'pickup_turns' && wasActiveHolder) {
      const after = await activeClaimsOfItem(itemId, c);
      if (after.length === 0) {
        phase = 'ventana_libre';
        freeWindowOpenedAt = nowIso();
      }
    }

    const activeCount = Number(
      (
        await c.query(
          `SELECT COUNT(*)::int AS n FROM claims WHERE item_id = $1 AND claim_state = 'active'`,
          [itemId]
        )
      ).rows[0].n
    );
    const legacyStatus = deriveLegacyStatus(phase, activeCount);

    if (phase !== row.phase || freeWindowOpenedAt !== row.free_window_opened_at) {
      await c.query(
        `UPDATE items SET phase = $2, free_window_opened_at = $3, status = $4, updated_at = NOW()
         WHERE id = $1`,
        [itemId, phase, freeWindowOpenedAt, legacyStatus]
      );
      patchItem(itemId, { phase, freeWindowOpenedAt, status: legacyStatus });
    } else {
      await c.query(`UPDATE items SET status = $2, updated_at = NOW() WHERE id = $1`, [
        itemId,
        legacyStatus
      ]);
      patchItem(itemId, { status: legacyStatus });
    }

    return {
      ok: true,
      itemId,
      userUuid,
      username,
      claimState: 'cancelado_voluntario',
      phase,
      status: legacyStatus,
      freeWindowOpenedAt,
      wasActiveHolder
    };
  }, client);
}

// ---------------------------------------------------------------------------
// 5b. Admin: evicción de un claimant (void) — recompone la cola activa
// ---------------------------------------------------------------------------

export type AdminEvictOutcome =
  | {
      ok: true;
      itemId: string;
      userUuid: string;
      username: string | null;
      claimState: ClaimState;
      phase: ItemPhase;
      status: ItemStatus;
      freeWindowOpenedAt: string | null;
      wasActiveHolder: boolean;
    }
  | { ok: false; code: 'no_active_claim' | 'already_delivered' | 'not_found'; message: string };

/**
 * El ADMIN expulsa a un usuario de la cola de un item: su claim activo pasa a
 * 'void' (perdió el derecho SIN sanción de confianza, como registro forense) y
 * la cola se recompone (si era el titular y no quedan activos, abre la ventana
 * libre en este instante). No aplica sanción (la decisión es del admin).
 */
export async function adminEvictClaim(
  itemId: string,
  userUuid: string,
  client?: DbClient
): Promise<AdminEvictOutcome> {
  return runTx(async (c) => {
    const row = await lockItemWithEvent(itemId, c);
    if (!row) return { ok: false, code: 'not_found', message: 'Item not found.' };

    const claimRes = await c.query(
      `SELECT c.id, c.claim_state, c.fifo_position, u.alias AS username
       FROM claims c JOIN users u ON c.user_uuid = u.uuid
       WHERE c.item_id = $1 AND c.user_uuid = $2
       ORDER BY c.claimed_at DESC, c.id DESC
       LIMIT 1`,
      [itemId, userUuid]
    );
    const claim = claimRes.rows[0];
    if (!claim || claim.claim_state !== 'active') {
      return { ok: false, code: 'no_active_claim', message: 'No active claim found for this item and user.' };
    }

    const username = claim.username ?? null;
    let phase = row.phase as ItemPhase;
    let freeWindowOpenedAt: string | null = row.free_window_opened_at ?? null;
    let wasActiveHolder = false;

    if (row.delivered_at || row.phase === 'entregado' || row.phase === 'enviado_a_caridad') {
      return { ok: false, code: 'already_delivered', message: 'Este objeto ya fue entregado.' };
    }

    if (row.phase === 'pickup_turns') {
      const firstActive = (
        await c.query(
          `SELECT id FROM claims
           WHERE item_id = $1 AND claim_state = 'active'
           ORDER BY fifo_position ASC NULLS LAST, claimed_at ASC, id ASC
           LIMIT 1`,
          [itemId]
        )
      ).rows[0];
      wasActiveHolder = firstActive?.id === claim.id;
    }

    await c.query(
      `UPDATE claims SET claim_state = 'void', updated_at = NOW() WHERE id = $1`,
      [claim.id]
    );
    patchClaim(itemId, claim.id, { claimState: 'void' });

    if (row.phase === 'pickup_turns' && wasActiveHolder) {
      const after = await activeClaimsOfItem(itemId, c);
      if (after.length === 0) {
        phase = 'ventana_libre';
        freeWindowOpenedAt = nowIso();
      }
    }

    const activeCount = Number(
      (
        await c.query(
          `SELECT COUNT(*)::int AS n FROM claims WHERE item_id = $1 AND claim_state = 'active'`,
          [itemId]
        )
      ).rows[0].n
    );
    const legacyStatus = deriveLegacyStatus(phase, activeCount);

    if (phase !== row.phase || freeWindowOpenedAt !== row.free_window_opened_at) {
      await c.query(
        `UPDATE items SET phase = $2, free_window_opened_at = $3, status = $4, updated_at = NOW()
         WHERE id = $1`,
        [itemId, phase, freeWindowOpenedAt, legacyStatus]
      );
      patchItem(itemId, { phase, freeWindowOpenedAt, status: legacyStatus });
    } else {
      await c.query(`UPDATE items SET status = $2, updated_at = NOW() WHERE id = $1`, [
        itemId,
        legacyStatus
      ]);
      patchItem(itemId, { status: legacyStatus });
    }

    return {
      ok: true,
      itemId,
      userUuid,
      username,
      claimState: 'void',
      phase,
      status: legacyStatus,
      freeWindowOpenedAt,
      wasActiveHolder
    };
  }, client);
}

// ---------------------------------------------------------------------------
// 6. ADMIN marca 'item recogido' (entrega) — conserva la cola como forense
// ---------------------------------------------------------------------------

export type AdminDeliverOutcome =
  | {
      ok: true;
      itemId: string;
      phase: ItemPhase;
      status: ItemStatus;
      deliveredClaimId: string | null;
      deliveredUsername: string | null;
      deliveredAt: string;
      eventId: string | null;
      voided: Array<{ claimId: string; userUuid: string; username: string | null }>;
    }
  | {
      ok: false;
      code: 'not_found' | 'already_closed' | 'invalid_phase' | 'no_active_holder' | 'invalid_claim';
      message: string;
    };

export interface AdminDeliverInput {
  itemId: string;
  /** Opcional: claim a marcar como entregado (ventana libre con claim capturado). */
  claimId?: string | null;
}

/**
 * El ADMIN marca 'item recogido': valida que haya un titular activo (pickup_turns)
 * o una ventana libre (con claim opcional); fija phase='entregado',
 * delivered_claim_id/delivered_at, conserva los claims como registro forense
 * (void a los demás activos, sin sanción) y detiene los workflows restantes
 * (la fase terminal 'entregado' deja de progresar automáticamente). Completar a
 * tiempo reduce el contador de expiraciones del titular (reward).
 */
export async function deliverItemByAdmin(
  input: AdminDeliverInput,
  client?: DbClient
): Promise<AdminDeliverOutcome> {
  const { itemId, claimId } = input;

  return runTx(async (c) => {
    const row = await lockItemWithEvent(itemId, c);
    if (!row) return { ok: false, code: 'not_found', message: 'Item not found.' };
    if (row.phase === 'entregado' || row.phase === 'enviado_a_caridad') {
      return { ok: false, code: 'already_closed', message: 'Este objeto ya está entregado o enviado a caridad.' };
    }
    if (row.phase !== 'pickup_turns' && row.phase !== 'ventana_libre') {
      return { ok: false, code: 'invalid_phase', message: 'El objeto aún no está en fase de recolección.' };
    }

    const active = await activeClaimsOfItem(itemId, c);

    let delivered: any = null;
    if (claimId) {
      delivered = active.find((a: any) => a.id === claimId) ?? null;
      if (!delivered) {
        return { ok: false, code: 'invalid_claim', message: 'El claim indicado no es un titular activo de este objeto.' };
      }
    } else if (row.phase === 'pickup_turns') {
      delivered = active[0] ?? null;
      if (!delivered) {
        return {
          ok: false,
          code: 'no_active_holder',
          message: 'No hay un titular de turno activo para marcar como entregado.'
        };
      }
    } else {
      // ventana_libre sin claim explícito: puede no existir claim (walk-in).
      delivered = active[0] ?? null;
    }

    const deliveredAt = nowIso();
    const deliveredClaimId = delivered ? delivered.id : null;

    // Void de los demás claims activos (forense, sin sanción).
    const voided: Array<{ claimId: string; userUuid: string; username: string | null }> = [];
    if (delivered) {
      const others = active.filter((a: any) => a.id !== delivered.id);
      for (const o of others) {
        await c.query(
          `UPDATE claims SET claim_state = 'void', updated_at = NOW() WHERE id = $1`,
          [o.id]
        );
        voided.push({ claimId: o.id, userUuid: o.user_uuid, username: o.username ?? null });
        patchClaim(itemId, o.id, { claimState: 'void' });
      }
    } else {
      for (const o of active) {
        await c.query(
          `UPDATE claims SET claim_state = 'void', updated_at = NOW() WHERE id = $1`,
          [o.id]
        );
        voided.push({ claimId: o.id, userUuid: o.user_uuid, username: o.username ?? null });
        patchClaim(itemId, o.id, { claimState: 'void' });
      }
    }

    await c.query(
      `UPDATE items
       SET phase = 'entregado', delivered_claim_id = $2, delivered_at = $3,
           status = 'unavailable', updated_at = NOW()
       WHERE id = $1`,
      [itemId, deliveredClaimId, deliveredAt]
    );
    patchItem(itemId, {
      phase: 'entregado',
      deliveredClaimId,
      deliveredAt,
      status: 'unavailable'
    });

    // Reward de confianza: completar a tiempo reduce el contador de expiraciones.
    if (row.event_id && delivered) {
      await reduceExpirationCount(row.event_id, delivered.user_uuid, c);
    }

    return {
      ok: true,
      itemId,
      phase: 'entregado',
      status: 'unavailable',
      deliveredClaimId,
      deliveredUsername: delivered ? delivered.username ?? null : null,
      deliveredAt,
      eventId: row.event_id,
      voided
    };
  }, client);
}

// ---------------------------------------------------------------------------
// Helpers de lectura para controllers / feeds
// ---------------------------------------------------------------------------

/** Claim activo (titular actual) de un item desde el store RAM. */
export function activeClaimFromStore(item: StoreItem): StoreClaim | undefined {
  const active = item.queue
    .filter((c) => c.claimState === 'active')
    .sort((a, b) => {
      const ap = a.fifoPosition === null ? Number.MAX_SAFE_INTEGER : a.fifoPosition;
      const bp = b.fifoPosition === null ? Number.MAX_SAFE_INTEGER : b.fifoPosition;
      if (ap !== bp) return ap - bp;
      return new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime();
    });
  return active[0];
}

/**
 * Conteo de claims activos de un usuario en el evento de un item, desde RAM
 * (para el límite de apartados simultáneos sin tocar la BD en el feed).
 */
export function countActiveApartadosInEvent(
  storeItems: StoreItem[],
  userUuid: string,
  eventId: string
): number {
  let n = 0;
  for (const it of storeItems) {
    if (it.eventId !== eventId) continue;
    if (it.queue.some((q) => q.userUuid === userUuid && q.claimState === 'active')) n++;
  }
  return n;
}

/**
 * Rol efectivo de un usuario para el feed (v2: rol GLOBAL del usuario es la
 * única fuente de verdad; la membresía por evento ya no aporta rol ni bonus).
 */
export function effectiveRoleForUser(globalRole: string | null | undefined): Role {
  return (resolveEffectiveRole(null, globalRole) as Role) || 'publico';
}
