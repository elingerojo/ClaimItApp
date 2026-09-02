import { Request, Response } from 'express';
import { ROLE_HIERARCHY, resolveEffectiveRole, resolvePickupHoursField } from '@claimitapp/shared';
import { getItems, getLedger, getUser, getEvent, getEventMembership, getTrustSetting } from '../cache/appStore.js';
import { runLazyCatchUp } from '../services/scheduler.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Single role resolution for a user in the context of an item's event:
 * membership role if the user is a member of that event, otherwise the user's
 * GLOBAL role as fallback. This is the ONLY place role is resolved for the
 * feed, so visibility, price and availability always agree (fixes the
 * "visibility vs membership" inconsistency).
 */
function resolveItemRole(
  item: { eventId: string | null },
  userUuid: string | undefined,
  userGlobalRole: string
): { role: string; bonusHours: number } {
  let membershipRole: string | null = null;
  let bonusHours = 0;

  if (item.eventId && userUuid) {
    const membership = getEventMembership(userUuid, item.eventId);
    if (membership) {
      membershipRole = membership.role;
      bonusHours = membership.bonusHours || 0;
    }
  }

  const role = resolveEffectiveRole(membershipRole, userGlobalRole);
  return { role, bonusHours };
}

/**
 * Effective availability of an item for a given (already resolved) role:
 *  - Base available_from = item override, else inherited from its event.
 *  - effective = base - (role advance_hours + membership bonus_hours).
 * Returns { effectiveAvailableFrom, canClaim }.
 */
function computeAvailability(
  item: {
    availableFrom: string | null;
    eventId: string | null;
  },
  role: string,
  bonusHours: number
): { effectiveAvailableFrom: string | null; canClaim: boolean } {
  const event = item.eventId ? getEvent(item.eventId) : null;
  const base = item.availableFrom ?? event?.available_from ?? null;

  if (!base) {
    // No scheduling configured -> always claimable (legacy behavior)
    return { effectiveAvailableFrom: null, canClaim: true };
  }

  const advanceHours = event?.[`${role}_advance_hours`] ?? 0;
  const effective = new Date(new Date(base).getTime() - (advanceHours + bonusHours) * HOUR_MS);

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

    const responsePayload = getItems()
      .map(item => {
        // 1. Resolve the SINGLE effective role for this item+user.
        const { role, bonusHours } = resolveItemRole(item, userUuid || undefined, userGlobalRole);
        const roleLevel = ROLE_HIERARCHY[role] || ROLE_HIERARCHY.publico;

        // 2. Visibility by RESOLVED role (membership > global fallback).
        if (item.visibilityLevel !== null && item.visibilityLevel < roleLevel) return null;

        // 3. Scheduled publication: invisible until visible_at (item override or event)
        const event = item.eventId ? getEvent(item.eventId) : null;
        const visibleAt = item.visibleAt ?? event?.published_at ?? null;
        if (visibleAt && new Date(visibleAt).getTime() > now) return null;

        // 4. Lifecycle gating: after claims_close_at (closing) no new claims;
        //    after pickup_deadline (closed) the item is done.
        const claimsCloseAt = event?.claims_close_at ?? null;
        const pickupDeadlineEvent = event?.pickup_deadline ?? null;
        const lifecycleLocked =
          (claimsCloseAt && new Date(claimsCloseAt).getTime() <= now) ||
          (pickupDeadlineEvent && new Date(pickupDeadlineEvent).getTime() <= now) ||
          event?.status === 'closed';

        const { effectiveAvailableFrom, canClaim } = computeAvailability(item, role, bonusHours);

        // Deadline of the requesting user's own claim (for the pickup indicator)
        const myClaim = userUuid ? item.queue.find(q => q.userUuid === userUuid) : undefined;

        // Solo el precio del nivel del usuario (el resto permanece oculto)
        const precioKey =
          ({ familiares: 'precioFamiliar', amigos: 'precioAmigo', conocidos: 'precioConocido', publico: 'precioPublico' } as const)[
            role
          ] ?? 'precioPublico';

        const myPickupWindowHours = resolveUserPickupWindowHours(item, role);

        return {
          id: item.id,
          title: item.title,
          description: item.description,
          category: item.category,
          infoUrl: item.infoUrl,
          imageUrl: item.imageUrl,
          status: item.status,
          visibilityLevel: item.visibilityLevel ?? 4, // Default to public
          eventId: item.eventId ?? null,
          visibleAt: item.visibleAt,
          availableFrom: item.availableFrom,
          effectiveAvailableFrom,
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
          // NUMERIC viene como string de pg; normalizar a número para la UI
          precioVisible:
            (item as any)[precioKey] != null ? Number((item as any)[precioKey]) : null,
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
    res.status(200).json(getLedger());
  } catch (error) {
    console.error('Failed to retrieve activity logs:', error);
    res.status(500).json({ error: 'Database execution error generating historical ledger records.' });
  }
};
