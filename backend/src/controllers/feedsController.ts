import { Request, Response } from 'express';
import {
  HOUR_MS,
  ROLE_HIERARCHY,
  type ItemPhase,
  type Role,
  type FixedTimeline
} from '@claimitapp/shared';
import {
  getItems,
  getLedger,
  getUser,
  getEvent,
  getTrustSetting,
  ensureHydrated,
  type StoreClaim,
  type StoreEvent,
  type StoreItem
} from '../cache/appStore.js';
import { runLazyCatchUp } from '../services/scheduler.js';
import { evaluateItemTemporalState, effectiveRoleForUser } from '../services/queueService.js';
import { rolePrice } from '../utils/pricing.js';

const toMs = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const d = new Date(v).getTime();
  return Number.isNaN(d) ? null : d;
};

/** Estado temporal compacto por item (sin participantes; la cola va aparte). */
function compactTemporalState(
  item: StoreItem,
  event: StoreEvent | undefined
): {
  estado_actual: string;
  tiempo_restante_turno_activo_segundos: number | null;
  linea_tiempo_fija: FixedTimeline | null;
} {
  const full = evaluateItemTemporalState({
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
  return {
    estado_actual: full.estado_actual,
    tiempo_restante_turno_activo_segundos: full.tiempo_restante_turno_activo_segundos,
    linea_tiempo_fija: full.linea_tiempo_fija
  };
}

function activeClaimOf(item: StoreItem, userUuid: string): StoreClaim | undefined {
  return item.queue.find((c) => c.userUuid === userUuid && c.claimState === 'active');
}

function activeCount(item: StoreItem): number {
  let n = 0;
  for (const c of item.queue) if (c.claimState === 'active') n++;
  return n;
}

/**
 * GET /api/items — feed de inventario v2 (dinámico por rol).
 *
 * - Filtrado por visibility_level y por visibilidad temporal del rol:
 *   visibleAt(rol) = published_at(base) − advance_pub_hours(rol) (matriz).
 * - "Lo quiero" (canClaim) se habilita por rol cuando
 *   now ∈ [claimFrom(rol), claims_close_at) y el item sigue en claim_open y la
 *   cola no está llena (clausura precoz a 3) y el usuario no está ya en cola.
 *   En ventana_libre canClaim=true = captura directa.
 * - Expone phase + estado temporal compacto (estado_actual, tiempo restante,
 *   línea de tiempo fija) y la cola forense v2.
 * Se sirve desde el store en RAM; el lazy catch-up mantiene el reloj al día.
 */
export const getInventoryFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    await ensureHydrated();
    await runLazyCatchUp();

    const userUuid = req.query.userUuid as string;
    let userGlobalRole = 'publico';
    if (userUuid) {
      const user = getUser(userUuid);
      if (user) userGlobalRole = user.global_role;
    }
    const role: Role = effectiveRoleForUser(userGlobalRole);
    const roleLevel = ROLE_HIERARCHY[role] ?? ROLE_HIERARCHY.publico;

    // Matriz de confianza del rol (adelanto pub/disp + límite de apartados).
    const trust = getTrustSetting(role) ?? {};
    const advancePubHours = Number(trust.advance_pub_hours_default ?? 0);
    const advanceDispHours = Number(trust.advance_disp_hours_default ?? 0);
    const simultaneousLimit = Number(trust.max_apartados_simultaneos ?? 1);

    const now = Date.now();
    const itemsSnapshot = getItems();

    // Apartados activos del usuario por evento (límite simultáneo real).
    const activeApartadosByEvent = new Map<string, number>();
    if (userUuid) {
      for (const it of itemsSnapshot) {
        if (!it.eventId) continue;
        if (it.queue.some((q) => q.userUuid === userUuid && q.claimState === 'active')) {
          activeApartadosByEvent.set(it.eventId, (activeApartadosByEvent.get(it.eventId) ?? 0) + 1);
        }
      }
    }

    const responsePayload = itemsSnapshot
      .map((item) => {
        // 1. Visibilidad por nivel (visibility_level).
        if (item.visibilityLevel !== null && item.visibilityLevel < roleLevel) return null;

        const event = item.eventId ? getEvent(item.eventId) : null;

        // 1b. Regla v2 "evento como fuente única": evento sin published_at (draft /
        // no publicado) ⇒ sus items NO son visibles en el feed público.
        if (!event?.published_at) return null;

        // 2. Visibilidad temporal por rol (cero columnas por evento — dinámico;
        // la base SIEMPRE es la del evento).
        const pubBase = event?.published_at ?? null;
        const availBase = event?.available_from ?? null;
        const visibleAtForRoleMs = pubBase ? toMs(pubBase)! - advancePubHours * HOUR_MS : null;
        const claimFromForRoleMs = availBase ? toMs(availBase)! - advanceDispHours * HOUR_MS : null;

        if (visibleAtForRoleMs !== null && visibleAtForRoleMs > now) return null;

        const claimsCloseMs = toMs(event?.claims_close_at ?? null);
        const pickupMs = toMs(event?.pickup_deadline ?? null);

        // 3. Capacidad de reclamar ("Lo quiero") para este rol.
        const alreadyInQueue = !!userUuid && !!activeClaimOf(item, userUuid);
        const activeApartadosInEvent =
          item.eventId && userUuid ? activeApartadosByEvent.get(item.eventId) ?? 0 : 0;

        let canClaim = false;
        let claimsClosed = true;
        if (item.phase === 'claim_open' && event?.status !== 'closed') {
          const withinWindow =
            (claimFromForRoleMs === null || now >= claimFromForRoleMs) &&
            (claimsCloseMs === null || now < claimsCloseMs);
          claimsClosed = !withinWindow;
          canClaim =
            withinWindow &&
            !alreadyInQueue &&
            activeCount(item) < 3 &&
            activeApartadosInEvent < simultaneousLimit;
        } else if (item.phase === 'ventana_libre') {
          claimsClosed = pickupMs !== null && now >= pickupMs;
          canClaim = !claimsClosed && !alreadyInQueue;
        }

        const myActive = userUuid ? activeClaimOf(item, userUuid) : undefined;
        const temporal = compactTemporalState(item, event ?? undefined);
        const myRoleInEvent = role;

        return {
          id: item.id,
          title: item.title,
          description: item.description,
          category: item.category,
          infoUrl: item.infoUrl,
          imageUrls: item.imageUrls,
          status: item.status,
          phase: item.phase as ItemPhase,
          visibilityLevel: item.visibilityLevel ?? 4,
          eventId: item.eventId ?? null,
          frozenAt: item.frozenAt ?? null,
          freeWindowOpenedAt: item.freeWindowOpenedAt ?? null,
          deliveredAt: item.deliveredAt ?? null,
          charityAt: item.charityAt ?? null,
          // Ventana por rol (dinámico puro, matriz pub/disp).
          myRoleInEvent,
          advancePubHours,
          advanceDispHours,
          visibleAtForRole: visibleAtForRoleMs !== null ? new Date(visibleAtForRoleMs).toISOString() : null,
          claimFromForRole: claimFromForRoleMs !== null ? new Date(claimFromForRoleMs).toISOString() : null,
          // Cortes del contenedor (iguales para todo rol en v2).
          effectiveClaimsCloseAt: claimsCloseMs !== null ? new Date(claimsCloseMs).toISOString() : null,
          effectivePickupDeadline: pickupMs !== null ? new Date(pickupMs).toISOString() : null,
          claimsClosed,
          canClaim,
          // Estado temporal compacto (v2).
          temporalState: temporal,
          // Límite de apartados simultáneos del rol dentro del evento.
          activeApartadosInEvent,
          simultaneousLimit,
          // Precio por rol (base × multiplicador de la matriz).
          precioVisible: rolePrice(item.precioBaseCosto, role),
          createdAt: item.createdAt,
          // Cola forense v2 (todos los estados) + mi claim activo.
          queue: item.queue,
          myClaim:
            myActive
              ? {
                  claimId: myActive.id,
                  claimState: myActive.claimState,
                  roleAtClaim: myActive.roleAtClaim,
                  fifoPosition: myActive.fifoPosition,
                  turnVExpiresAt: myActive.turnVExpiresAt,
                  claimedAt: myActive.claimedAt
                }
              : null,
          eventSummary: event
            ? {
                id: event.id,
                title: event.title ?? null,
                status: event.status ?? 'draft',
                published_at: event.published_at,
                available_from: event.available_from,
                claims_close_at: event.claims_close_at,
                pickup_deadline: event.pickup_deadline,
                pickup_schedule_info: event.pickup_schedule_info ?? null
              }
            : null
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    res.status(200).json(responsePayload);
  } catch (error) {
    console.error('Failed to retrieve inventory feed:', error);
    res.status(500).json({ error: 'Database processing error fetching item grid aggregates.' });
  }
};

/**
 * GET /api/ledger — historial de actividad (store en RAM, sin Neon).
 */
export const getLedgerFeed = async (_req: Request, res: Response): Promise<void> => {
  try {
    await ensureHydrated();
    res.status(200).json(getLedger());
  } catch (error) {
    console.error('Failed to retrieve activity logs:', error);
    res.status(500).json({ error: 'Database execution error generating historical ledger records.' });
  }
};
