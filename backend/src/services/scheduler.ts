/**
 * backend/src/services/scheduler.ts — Automatizaciones temporales v2 (lazy)
 *
 * Implementa el "lazy catch-up" de la Estrategia temporal v2:
 *
 *  - Al entrar actividad (feed read, claim, pickup admin, SSE connect) se invoca
 *    `runLazyCatchUp()`, que SOLO toca Neon cuando el store en RAM muestra trabajo
 *    pendiente (así Neon puede autosuspenderse con cero tráfico):
 *      (a) congelar items `claim_open` cuyo claims_close_at (T_inicio) <= now;
 *      (b) aplicar transiciones por reloj (`applyDueTransitions`) a items en
 *          pickup_turns / ventana_libre (expirio de turnos, avance, apertura de
 *          ventana libre, caridad al T_final);
 *      (c) avanzar el estatus de los eventos (scheduled/active/closing/closed);
 *      (d) purgar tras la gracia (PURGE_CLOSED_DAYS) los items de eventos
 *          'closed' / fase enviado_a_caridad.
 *
 * Modo poll opcional: SCHEDULER_ENABLED=true restaura intervalos fijos.
 * Cada item se procesa en su propia transacción (row-lock FOR UPDATE) y las
 * transiciones emiten SSE ('item_updated' con reason: item_frozen /
 * turn_expired / free_window_opened / sent_to_charity).
 */
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import {
  deriveLegacyStatus,
  getEvent,
  getItemById,
  getItems,
  removeItem,
  setEventStatusInStore
} from '../cache/appStore.js';
import { logAudit } from '../utils/auditLog.js';
import { applyDueTransitions, freezeItemIfDue } from './queueService.js';

// ---------------------------------------------------------------------------
// Detección en RAM (sin tocar Neon) — patrón lazy
// ---------------------------------------------------------------------------

function eventMs(itemId: string, field: 'claims_close_at' | 'pickup_deadline'): number | null {
  const item = getItemById(itemId);
  if (!item?.eventId) return null;
  const evt = getEvent(item.eventId);
  const v = evt ? (evt as any)[field] : null;
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** ¿Hay items `claim_open` cuyo T_inicio (claims_close_at) ya pasó? */
export function hasDueFreezeInStore(): boolean {
  const now = Date.now();
  for (const item of getItems()) {
    if (item.phase !== 'claim_open') continue;
    const close = eventMs(item.id, 'claims_close_at');
    if (close !== null && now >= close) return true;
  }
  return false;
}

/**
 * ¿Hay items congelados (pickup_turns / ventana_libre) que requieren una
 * transición por reloj? (turno activo vencido o T_final alcanzado = caridad).
 */
export function hasDueTransitionInStore(): boolean {
  const now = Date.now();
  for (const item of getItems()) {
    if (item.phase === 'claim_open' || item.phase === 'entregado' || item.phase === 'enviado_a_caridad') {
      continue;
    }
    const tFinal = eventMs(item.id, 'pickup_deadline');
    if (tFinal !== null && now >= tFinal) return true;
    for (const claim of item.queue) {
      if (claim.claimState === 'active' && claim.turnVExpiresAt) {
        const v = new Date(claim.turnVExpiresAt).getTime();
        if (!Number.isNaN(v) && v <= now) return true;
      }
    }
  }
  return false;
}

/**
 * True cuando el store en RAM tiene work pendiente por reloj (freeze o
 * transiciones). Es el nombre histórico conservado (la Fase 2 lo usaba para
 * deadlines de pickup); ahora engloba toda la maquinaria v2.
 */
export function hasOverdueDeadlinesInStore(): boolean {
  return hasDueFreezeInStore() || hasDueTransitionInStore();
}

/** Items candidatos a congelar (phase claim_open y T_inicio vencido). */
function dueFreezeItemIds(): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const item of getItems()) {
    if (item.phase !== 'claim_open') continue;
    const close = eventMs(item.id, 'claims_close_at');
    if (close !== null && now >= close) out.push(item.id);
  }
  return out;
}

/** Items candidatos a transición por reloj (pickup_turns/ventana_libre). */
function dueTransitionItemIds(): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const item of getItems()) {
    if (item.phase !== 'pickup_turns' && item.phase !== 'ventana_libre') continue;
    const tFinal = eventMs(item.id, 'pickup_deadline');
    let due = tFinal !== null && now >= tFinal;
    if (!due) {
      due = item.queue.some(
        (c) =>
          c.claimState === 'active' &&
          c.turnVExpiresAt &&
          new Date(c.turnVExpiresAt).getTime() <= now
      );
    }
    if (due) out.push(item.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Broadcast de estados (SSE) — nuevos reasons v2
// ---------------------------------------------------------------------------

function broadcastItemState(itemId: string, extra: Record<string, unknown>): void {
  const item = getItemById(itemId);
  broadcastSseEvent('item_updated', {
    itemId,
    phase: item?.phase ?? null,
    status: item?.status ?? 'unavailable',
    ...extra
  });
}

// ---------------------------------------------------------------------------
// Procesamiento por reloj (freeze + transiciones)
// ---------------------------------------------------------------------------

/**
 * Congela todos los items vencidos y aplica las transiciones por reloj
 * pendientes. Cada item va en su propia transacción (funciones self-contained
 * de queueService) y emite SSE por cambio. Devuelve el número de items tocados.
 */
export async function processClockWork(): Promise<number> {
  let processed = 0;

  // (a) Freeze de items claim_open con T_inicio alcanzado.
  const freezeIds = dueFreezeItemIds();
  for (const itemId of freezeIds) {
    try {
      const res = await freezeItemIfDue(itemId);
      if (res && res.frozen) {
        processed++;
        broadcastItemState(itemId, {
          reason: 'item_frozen',
          frozenAt: res.frozenAt,
          frozenSchedule: res.frozenSchedule,
          queueCount: res.queueCount
        });
        console.log(
          `[Scheduler] Freeze item ${itemId} → phase=${res.phase} (${res.queueCount} en cola)`
        );
      }
    } catch (err) {
      console.error(`[Scheduler] freezeItemIfDue failed for ${itemId}:`, err);
    }
  }

  // (b) Transiciones por reloj (los items recién congelados pueden necesitarlas
  // si T_inicio quedó atrás y un turno ya venció).
  const transitionIds = dueTransitionItemIds();
  for (const itemId of transitionIds) {
    try {
      const res = await applyDueTransitions(itemId);
      if (!res.changed) continue;
      processed++;
      if (res.expired.length > 0) {
        broadcastItemState(itemId, {
          reason: 'turn_expired',
          expired: res.expired.map((e) => ({
            userUuid: e.userUuid,
            username: e.username,
            role: e.role,
            sanctioned: e.sanctioned
          })),
          activeRemaining: res.activeRemaining
        });
      }
      if (res.freeWindowOpenedAt) {
        broadcastItemState(itemId, {
          reason: 'free_window_opened',
          freeWindowOpenedAt: res.freeWindowOpenedAt
        });
      }
      if (res.charityAt) {
        broadcastItemState(itemId, {
          reason: 'sent_to_charity',
          charityAt: res.charityAt,
          voidedCount: res.voidedCount
        });
      }
      console.log(
        `[Scheduler] Transitions item ${itemId} → phase=${res.phase}, expired=${res.expired.length}`
      );
    } catch (err) {
      console.error(`[Scheduler] applyDueTransitions failed for ${itemId}:`, err);
    }
  }

  return processed;
}

// ---------------------------------------------------------------------------
// Estatus de eventos (labels; gates reales por reloj en queueService)
// ---------------------------------------------------------------------------

/** ¿Hay algún evento (referenciado por items) que requiera avanzar de status? */
export function hasEventStatusDueInStore(): boolean {
  const now = Date.now();
  const seen = new Set<string>();
  for (const item of getItems()) {
    if (!item.eventId || seen.has(item.eventId)) continue;
    seen.add(item.eventId);
    const evt = getEvent(item.eventId);
    if (!evt) continue;
    const status = evt.status;
    const published = evt.published_at ? new Date(evt.published_at).getTime() : null;
    const available = evt.available_from ? new Date(evt.available_from).getTime() : null;
    const claimsClose = evt.claims_close_at ? new Date(evt.claims_close_at).getTime() : null;
    const pickup = evt.pickup_deadline ? new Date(evt.pickup_deadline).getTime() : null;
    if (
      (status === 'draft' && published !== null && published <= now + 86_400_000) ||
      ((status === 'draft' || status === 'scheduled') && available !== null && available <= now) ||
      (status === 'active' && claimsClose !== null && claimsClose <= now) ||
      ((status === 'active' || status === 'closing') && pickup !== null && pickup <= now)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Avanza el estatus de los eventos por reloj (draft→scheduled→active→closing→
 * closed). Solo etiquetas: los gates de claims/recogida usan las fechas reales.
 * Write-through a RAM vía setEventStatusInStore.
 */
export async function advanceEventStatuses(): Promise<number> {
  const client = await pool.connect();
  let changed = 0;
  try {
    const transitions = [
      // draft -> scheduled (publicación inminente/publicada)
      {
        sql: `UPDATE events SET status = 'scheduled', updated_at = NOW()
              WHERE status = 'draft' AND published_at IS NOT NULL
                AND published_at <= NOW() + interval '1 day'
              RETURNING id`
      },
      // draft|scheduled -> active (available_from alcanzado y evento publicado;
      // un draft sin published_at nunca se activa solo)
      {
        sql: `UPDATE events SET status = 'active', updated_at = NOW()
              WHERE status IN ('draft','scheduled') AND published_at IS NOT NULL
                AND available_from <= NOW()
              RETURNING id`
      },
      // active -> closing (T_inicio alcanzado)
      {
        sql: `UPDATE events SET status = 'closing', updated_at = NOW()
              WHERE status = 'active' AND claims_close_at IS NOT NULL
                AND claims_close_at <= NOW()
              RETURNING id`
      },
      // active|closing -> closed (T_final alcanzado = caridad/fin)
      {
        sql: `UPDATE events SET status = 'closed', updated_at = NOW()
              WHERE status IN ('active','closing') AND pickup_deadline IS NOT NULL
                AND pickup_deadline <= NOW()
              RETURNING id`
      }
    ];
    for (const t of transitions) {
      const res = await client.query(t.sql);
      for (const r of res.rows) setEventStatusInStore(r.id, inferStatusFrom(t.sql));
      changed += res.rows.length;
    }
    if (changed > 0) {
      console.log(`[Scheduler] advanced status of ${changed} events (by clock)`);
    }
  } catch (err) {
    console.error('[Scheduler] advanceEventStatuses failed:', err);
  } finally {
    client.release();
  }
  return changed;
}

function inferStatusFrom(sql: string): string {
  if (sql.includes("status = 'scheduled'")) return 'scheduled';
  if (sql.includes("status = 'active'")) return 'active';
  if (sql.includes("status = 'closing'")) return 'closing';
  return 'closed';
}

// ---------------------------------------------------------------------------
// Purga tras la gracia (patrón conservado, adaptado a v2)
// ---------------------------------------------------------------------------

/** Días de gracia (post pickup_deadline) tras los cuales se purgan los items. */
export function purgeGraceDays(): number {
  const days = parseInt(process.env.PURGE_CLOSED_DAYS || '30', 10);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

/** Chequeo en RAM: existe un item purgable de un evento 'closed' vencido. */
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
 * Purga items de eventos 'closed' cuya pickup_deadline venció hace al menos
 * PURGE_CLOSED_DAYS días. Elimina items (+ claims por ON DELETE CASCADE) en Neon
 * y RAM, emite item_deleted y audita.
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
      await client.query('DELETE FROM items WHERE id = $1', [r.item_id]);
      removeItem(r.item_id);
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

// ---------------------------------------------------------------------------
// Catch-up perezoso + arranque
// ---------------------------------------------------------------------------

/**
 * Lazy catch-up v2: toca Neon solo cuando el store en RAM muestra trabajo
 * (freeze / transiciones / estatus de eventos / purga). Llamar en actividad:
 * feed read, claim, leave, deliver admin, SSE connect.
 */
export async function runLazyCatchUp(): Promise<number> {
  let total = 0;
  if (hasDueFreezeInStore() || hasDueTransitionInStore()) {
    total += await processClockWork();
  }
  if (hasEventStatusDueInStore()) {
    total += await advanceEventStatuses();
  }
  if (hasPurgeableClosedEvents()) {
    total += await purgeExpiredClosedInventory();
  }
  return total;
}

/**
 * Alias conservado para el modo poll opcional (procesa el trabajo por reloj).
 */
export async function verifyDeadlines(): Promise<void> {
  await runLazyCatchUp();
}

/**
 * Release batches: cuando la apertura del EVENTO (available_from) llega, emite
 * item_updated para sus items. Regla v2 "evento como fuente única" (antes se
 * consultaba items.available_from). Solo se usa en el modo poll opcional; el
 * feed ya calcula la visibilidad dinámicamente.
 */
export async function releaseBatches(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT i.id
       FROM items i
       JOIN events e ON i.event_id = e.id
       WHERE e.available_from IS NOT NULL AND e.available_from <= NOW()`
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
 * Arranca las automatizaciones. Default = LAZY (sin polling) para que Neon
 * autosuspenda con cero tráfico. SCHEDULER_ENABLED=true restaura los polls.
 */
export function startScheduler(): void {
  const enabled = process.env.SCHEDULER_ENABLED === 'true';

  if (!enabled) {
    console.log(
      '[Scheduler] LAZY MODE (default): catch-up v2 por actividad (freeze + transiciones + caridad). ' +
        'Neon puede autosuspenderse. Para polls periódicos setea SCHEDULER_ENABLED=true.'
    );
    return;
  }

  const releaseSec = Math.max(parseInt(process.env.SCHEDULER_RELEASE_SEC || '300', 10), 60);
  const clockMin = Math.max(parseInt(process.env.SCHEDULER_DEADLINE_MIN || '15', 10), 1);
  const purgeHours = Math.max(parseInt(process.env.SCHEDULER_PURGE_HOURS || '24', 10), 1);

  setInterval(() => {
    runLazyCatchUp().catch(() => {});
  }, clockMin * 60 * 1000);
  setInterval(() => {
    releaseBatches().catch(() => {});
  }, releaseSec * 1000);
  setInterval(() => {
    purgeExpiredClosedInventory().catch(() => {});
  }, purgeHours * 3600 * 1000);

  console.log(
    `[Scheduler] POLL MODE enabled: runLazyCatchUp cada ${clockMin} min, releaseBatches cada ${releaseSec}s, purge cada ${purgeHours}h.`
  );
}
