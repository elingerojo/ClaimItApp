import { Request, Response } from 'express';
import { ROLE_HIERARCHY } from '@claimitapp/shared';
import { getItems, getLedger, getUser } from '../cache/appStore.js';

/**
 * GET /api/items
 *
 * Se sirve EXCLUSIVAMENTE desde el store en RAM (appStore). No consulta Neon:
 * los writes (claims, items CRUD, evict) ya actualizan el store en el mismo
 * `await` (write-through). Esto permite que Neon se suspenda en inactividad.
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

    // Filtro de visibilidad por rol aplicado en memoria
    const responsePayload = getItems()
      .filter(item => item.visibilityLevel === null || item.visibilityLevel >= userRoleLevel)
      .map(item => ({
        id: item.id,
        title: item.title,
        description: item.description,
        category: item.category,
        infoUrl: item.infoUrl,
        imageUrl: item.imageUrl,
        status: item.status,
        visibilityLevel: item.visibilityLevel ?? 4, // Default to public
        eventId: item.eventId ?? null,
        createdAt: item.createdAt,
        queue: item.queue
      }));

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
