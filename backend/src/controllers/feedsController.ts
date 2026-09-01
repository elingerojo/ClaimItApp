import { Request, Response } from 'express';
import { ROLE_HIERARCHY } from '@claimitapp/shared';
import { getItems, getLedger, getUser, getEvent, getEventMembership } from '../cache/appStore.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Effective availability of an item for a given user:
 *  - Base available_from = item override, else inherited from its event.
 *  - effective = base - (role advance_hours + membership bonus_hours).
 * Returns { effectiveAvailableFrom, canClaim }.
 */
function computeAvailability(
  item: {
    availableFrom: string | null;
    eventId: string | null;
  },
  userUuid: string | undefined,
  userRole: string
): { effectiveAvailableFrom: string | null; canClaim: boolean } {
  let event = item.eventId ? getEvent(item.eventId) : null;
  const base = item.availableFrom ?? event?.available_from ?? null;

  if (!base) {
    // No scheduling configured -> always claimable (legacy behavior)
    return { effectiveAvailableFrom: null, canClaim: true };
  }

  let role = userRole;
  let bonusHours = 0;
  if (item.eventId && userUuid) {
    const membership = getEventMembership(userUuid, item.eventId);
    if (membership) {
      role = membership.role;
      bonusHours = membership.bonusHours || 0;
    }
  }

  const advanceHours = event?.[`${role}_advance_hours`] ?? 0;
  const effective = new Date(new Date(base).getTime() - (advanceHours + bonusHours) * HOUR_MS);

  return {
    effectiveAvailableFrom: effective.toISOString(),
    canClaim: effective.getTime() <= Date.now()
  };
}

/**
 * GET /api/items
 *
 * Se sirve EXCLUSIVAMENTE desde el store en RAM (appStore). No consulta Neon:
 * los writes (claims, items CRUD, evict, events) ya actualizan el store en el
 * mismo `await` (write-through). Esto permite que Neon se suspenda en inactividad.
 *
 * Filtra por visibility_level (rol del usuario) y por visible_at (publicación
 * programada); además calcula effectiveAvailableFrom/canClaim por usuario.
 */
export const getInventoryFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    const userUuid = req.query.userUuid as string;
    let userRole = 'publico'; // Default for unauthenticated users

    // Rol del usuario desde el store (sin query a Neon)
    if (userUuid) {
      const user = getUser(userUuid);
      if (user) userRole = user.global_role;
    }

    const userRoleLevel = ROLE_HIERARCHY[userRole] || ROLE_HIERARCHY.publico;
    const now = Date.now();

    const responsePayload = getItems()
      .filter(item => {
        // Visibility by role
        if (item.visibilityLevel !== null && item.visibilityLevel < userRoleLevel) return false;

        // Scheduled publication: invisible until visible_at (item override or event)
        const event = item.eventId ? getEvent(item.eventId) : null;
        const visibleAt = item.visibleAt ?? event?.published_at ?? null;
        if (visibleAt && new Date(visibleAt).getTime() > now) return false;

        return true;
      })
      .map(item => {
        const { effectiveAvailableFrom, canClaim } = computeAvailability(
          item,
          userUuid,
          userRole
        );
        // Deadline of the requesting user's own claim (for the pickup indicator)
        const myClaim = userUuid ? item.queue.find(q => q.userUuid === userUuid) : undefined;
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
          canClaim,
          myPickupDeadline: myClaim?.pickupDeadline ?? null,
          createdAt: item.createdAt,
          queue: item.queue
        };
      });

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
