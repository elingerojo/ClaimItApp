import { Request, Response } from 'express';
import {
  ROLE_HIERARCHY,
  resolveEffectiveRole,
  resolvePickupHoursField,
  buildRoleTimeline
} from '@claimitapp/shared';
import {
  getItems,
  getLedger,
  getUser,
  getEvent,
  getEventMembership,
  getTrustSetting,
  ensureHydrated
} from '../cache/appStore.js';
import { runLazyCatchUp } from '../services/scheduler.js';
import { rolePrice } from '../utils/pricing.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Role resolution for an item's event: roles are now GLOBAL (single source of
 * truth, relative to the sole admin), so the resolved role is simply the user's
 * global role. Membership only contributes referral bonus hours. This is the
 * ONLY place role is resolved for the feed, so visibility, price and
 * availability always agree.
 */
function resolveItemRole(
  item: { eventId: string | null },
  userUuid: string | undefined,
  userGlobalRole: string
): { role: string; bonusHours: number } {
  let bonusHours = 0;

  if (item.eventId && userUuid) {
    const membership = getEventMembership(userUuid, item.eventId);
    if (membership) bonusHours = membership.bonusHours || 0;
  }

  const role = resolveEffectiveRole(null, userGlobalRole);
  return { role, bonusHours };
}

/**
 * Effective availability of an item for a given (already resolved) role:
 *  - Base available_from = item override, else inherited from its event.
 *  - effective = base - A, where A = role advance_hours + membership bonus.
 * Start dates shift EARLIER (−A); end dates shift LATER (+A) elsewhere.
 * Returns { effectiveAvailableFrom, canClaim }.
 */
function computeAvailability(
  baseAvailable: string | null,
  totalAdvanceHours: number
): { effectiveAvailableFrom: string | null; canClaim: boolean } {
  if (!baseAvailable) {
    // No scheduling configured -> always claimable (legacy behavior)
    return { effectiveAvailableFrom: null, canClaim: true };
  }

  const effective = new Date(new Date(baseAvailable).getTime() - totalAdvanceHours * HOUR_MS);

  return {
    effectiveAvailableFrom: effective.toISOString(),
    canClaim: effective.getTime() <= Date.now()
  };
}

/**
 * Resolve the pickup window (hours) that would apply to the user on this item
 * given their (resolved) role. Mirrors queueService.resolvePickupWindow so the
 * number shown to the claimant BEFORE claiming equals the one frozen on the
 * claim: event.<rol>_pickup_hours → trust-matrix default → legacy 24h.
 */
function resolveUserPickupWindowHours(
  item: { eventId: string | null },
  role: string
): number | null {
  const event = item.eventId ? getEvent(item.eventId) : null;
  const field = resolvePickupHoursField(role);
  if (field && event?.[field] != null) return Number(event[field]);

  const trustDefault = getTrustSetting(role)?.intervalo_recoleccion_horas_default;
  if (trustDefault != null) return Number(trustDefault);

  if (event?.pickup_window_hours != null) return Number(event.pickup_window_hours);
  return 24;
}

/**
 * GET /api/items
 *
 * Se sirve EXCLUSIVAMENTE desde el store en RAM (appStore). No consulta Neon:
 * los writes (claims, items CRUD, evict, events) ya actualizan el store en el
 * mismo `await` (write-through). Esto permite que Neon se suspenda en inactividad.
 *
 * Filtra por visibility_level (ROL RESUELTO por membresía, con fallback a rol
 * global) y por visible_at (publicación programada); además calcula
 * effectiveAvailableFrom/canClaim por usuario. Los claims se cortan cuando el
 * evento entra en closing/closed (claims_close_at / pickup_deadline).
 */
export const getInventoryFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    // Self-heal: si el rehidratado de arranque falló (Neon frío), la primera
    // lectura recarga el store desde Neon. Sin esto el feed quedaría vacío
    // hasta el próximo redeploy. En el caso sano NO toca la BD.
    await ensureHydrated();

    // Catch-up perezoso: resolver deadlines vencidos solo si hay actividad.
    // Con store limpio no toca Neon (preserva el autosuspend).
    await runLazyCatchUp();

    const userUuid = req.query.userUuid as string;
    let userGlobalRole = 'publico'; // Default for unauthenticated users

    // Rol global del usuario desde el store (sin query a Neon)
    if (userUuid) {
      const user = getUser(userUuid);
      if (user) userGlobalRole = user.global_role;
    }

    const now = Date.now();

    const itemsSnapshot = getItems();
    // Apartados activos del usuario por evento (items del catálogo cuya cola lo
    // contiene) — para mostrar los límites simultáneos reales por evento.
    const activeApartadosByEvent = new Map<string, number>();
    if (userUuid) {
      for (const it of itemsSnapshot) {
        if (!it.eventId || !it.queue.some((q) => q.userUuid === userUuid)) continue;
        activeApartadosByEvent.set(it.eventId, (activeApartadosByEvent.get(it.eventId) ?? 0) + 1);
      }
    }

    const responsePayload = itemsSnapshot
      .map(item => {
        // 1. Resolve the SINGLE effective role for this item+user.
        const { role, bonusHours } = resolveItemRole(item, userUuid || undefined, userGlobalRole);
        const roleLevel = ROLE_HIERARCHY[role] || ROLE_HIERARCHY.publico;
        // Límite de apartados simultáneos del rol en el evento (matriz de confianza).
        const simultaneousLimit = getTrustSetting(role)?.max_apartados_simultaneos ?? 1;

        // 2. Visibility by RESOLVED role (membership > global fallback).
        if (item.visibilityLevel !== null && item.visibilityLevel < roleLevel) return null;

        const event = item.eventId ? getEvent(item.eventId) : null;

        // Per-role symmetric advantage: A = event <rol>_advance_hours + membership bonus.
        const advanceHours = event ? Number(event?.[`${role}_advance_hours`] ?? 0) || 0 : 0;
        const A = advanceHours + (bonusHours || 0);
        const widenMs = A * HOUR_MS;
        // Single-source helper for the event's 4 dates (start −A, end +A).
        const timeline = event
          ? buildRoleTimeline(
              {
                publishedAt: event.published_at ?? null,
                availableFrom: event.available_from ?? null,
                claimsCloseAt: event.claims_close_at ?? null,
                pickupDeadline: event.pickup_deadline ?? null
              },
              A
            )
          : null;

        // 3. Role-aware publication: the item becomes visible to this role when its
        //    effective visible time (item.visible_at, else event.published_at, shifted
        //    EARLIER by A) has arrived. Higher roles therefore see the catalog before
        //    the public base publication.
        const visibleBase = item.visibleAt ?? event?.published_at ?? null;
        const effVisibleMs = visibleBase ? new Date(visibleBase).getTime() - widenMs : null;
        if (effVisibleMs !== null && effVisibleMs > now) return null;

        // 4. Role-aware lifecycle (timing strategy): end dates shift LATER (+A), so a
        //    higher role may keep claiming/picking up past the public base close.
        //    Event status is only a global label; per-role cutoffs use role dates.
        const baseAvailable = item.availableFrom ?? event?.available_from ?? null;
        const effClaimsCloseMs = timeline?.claimsCloseAt?.getTime() ?? null;
        const effPickupMs = timeline?.pickupDeadline?.getTime() ?? null;
        const lifecycleLocked =
          (effClaimsCloseMs !== null && effClaimsCloseMs <= now) ||
          (effPickupMs !== null && effPickupMs <= now) ||
          (event?.status === 'closed' && effClaimsCloseMs === null && effPickupMs === null);

        const { effectiveAvailableFrom, canClaim } = computeAvailability(baseAvailable, A);

        // Deadline of the requesting user's own claim (for the pickup indicator)
        const myClaim = userUuid ? item.queue.find(q => q.userUuid === userUuid) : undefined;

        const myPickupWindowHours = resolveUserPickupWindowHours(item, role);

        return {
          id: item.id,
          title: item.title,
          description: item.description,
          category: item.category,
          infoUrl: item.infoUrl,
          // Arreglo ordenado completo: la lista usa imageUrls[0], el detalle los thumbnails.
          imageUrls: item.imageUrls,
          status: item.status,
          visibilityLevel: item.visibilityLevel ?? 4, // Default to public
          eventId: item.eventId ?? null,
          visibleAt: item.visibleAt,
          availableFrom: item.availableFrom,
          effectiveAvailableFrom,
          // Effective end of this role's window (base + A), for the UI.
          effectiveClaimsCloseAt:
            effClaimsCloseMs !== null ? new Date(effClaimsCloseMs).toISOString() : null,
          effectivePickupDeadline:
            effPickupMs !== null ? new Date(effPickupMs).toISOString() : null,
          // Consistent role/context for the UI (claimant side)
          myRoleInEvent: role,
          canClaim: canClaim && !lifecycleLocked,
          claimsClosed: lifecycleLocked,
          myPickupWindowHours,
          myPickupDeadline: myClaim?.pickupDeadline ?? null,
          eventSummary: event
            ? {
                id: event.id,
                title: event.title ?? null,
                status: event.status ?? 'draft',
                available_from: event.available_from,
                claims_close_at: event.claims_close_at,
                pickup_deadline: event.pickup_deadline,
                pickup_schedule_info: event.pickup_schedule_info ?? null
              }
            : null,
          // Límites de apartados simultáneos del rol dentro del evento (B4)
          activeApartadosInEvent:
            item.eventId && userUuid ? (activeApartadosByEvent.get(item.eventId) ?? 0) : 0,
          simultaneousLimit,
          // Precio del nivel del usuario calculado en tiempo de lectura
          // (precio_base_costo × multiplicador del rol resuelto, utils/pricing).
          // El resto de niveles permanece oculto.
          precioVisible: rolePrice(item.precioBaseCosto, role),
          createdAt: item.createdAt,
          queue: item.queue
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
 * GET /api/ledger
 *
 * Se sirve desde el store en RAM (appStore), sin tocar Neon.
 */
export const getLedgerFeed = async (_req: Request, res: Response): Promise<void> => {
  try {
    // Mismo self-heal que el feed de items: sin esto el historial quedaría
    // vacío tras un rehidratado de arranque fallido.
    await ensureHydrated();

    res.status(200).json(getLedger());
  } catch (error) {
    console.error('Failed to retrieve activity logs:', error);
    res.status(500).json({ error: 'Database execution error generating historical ledger records.' });
  }
};
