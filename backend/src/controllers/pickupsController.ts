/**
 * backend/src/controllers/pickupsController.ts — Recepción / entrega por usuario.
 *
 * Pantalla admin "Registrar entrega": el ADMIN busca a la persona que llegó, la
 * app lista SOLO los items donde ese usuario es el titular de mayor prioridad de
 * recogida (claim_open / pickup_turns) o donde tiene un claim activo en ventana
 * libre, el admin marca con checkboxes los objetos que le entrega y un único
 * POST graba todas las entregas.
 *
 * Endpoints (todos detrás de requireAdminSession):
 *  - GET  /api/admin/users?q=<texto>&limit=<n> — búsqueda de identidad.
 *  - GET  /api/admin/pickups?userUuid=<uuid>  — items recogibles por el usuario.
 *  - POST /api/admin/pickups/deliver           — entrega batch (por item).
 *
 * Delega en `deliverItemByAdmin` (queueService), que permite forzar la entrega
 * desde claim_open y valida la prioridad del usuario (nunca salta el FIFO).
 */

import { Request, Response } from 'express';
import pool from '../config/db.js';
import type { Role } from '@claimitapp/shared';
import { broadcastSseEvent } from '../config/sse.js';
import { ensureHydrated, getEvent, getItemById, getItems } from '../cache/appStore.js';
import { deliverItemByAdmin, pickableItemsForUser } from '../services/queueService.js';
import { runLazyCatchUp } from '../services/scheduler.js';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';

/** Tope de usuarios devueltos por la búsqueda admin. */
const MAX_USER_RESULTS = 25;
/** Tope de items procesados en una sola entrega batch. */
const MAX_BATCH_ITEMS = 100;

function adminSuffix(req: Request): string {
  return maskAdminCode(String((req as any).adminSession?.id ?? ''));
}

function toRole(v: unknown): Role {
  return ((String(v ?? '') || 'publico') as Role);
}

/**
 * GET /api/admin/users?q=<texto>&limit=<n>
 * Busca usuarios por alias/email/phone (ILIKE). Sin `q` devuelve los más
 * recientes. Solo detrás de sesión admin (expone email/phone).
 */
export const searchUsers = async (req: Request, res: Response): Promise<void> => {
  const q = String(req.query.q ?? '').trim();
  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_USER_RESULTS)
      : MAX_USER_RESULTS;

  try {
    const result = q
      ? await pool.query(
          `SELECT uuid, alias, email, phone, global_role
           FROM users
           WHERE alias ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1
           ORDER BY alias ASC
           LIMIT $2`,
          [`%${q}%`, limit]
        )
      : await pool.query(
          `SELECT uuid, alias, email, phone, global_role
           FROM users
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );

    res.status(200).json({
      users: result.rows.map((r: any) => ({
        uuid: r.uuid,
        alias: r.alias,
        email: r.email ?? null,
        phone: r.phone ?? null,
        globalRole: toRole(r.global_role)
      }))
    });
  } catch (error) {
    console.error('Admin user search failed:', error);
    res.status(500).json({ error: 'Database error searching users.' });
  }
};

/**
 * GET /api/admin/pickups?userUuid=<uuid>
 * Devuelve el usuario + los items donde es el titular de mayor prioridad.
 * Corre el lazy catch-up antes de calcular (freeze/expirios/ventana/caridad).
 */
export const listPickableItems = async (req: Request, res: Response): Promise<void> => {
  const userUuid = String(req.query.userUuid ?? '').trim();
  if (!userUuid) {
    res.status(400).json({ error: 'Query param "userUuid" is required.' });
    return;
  }

  try {
    await ensureHydrated();
    await runLazyCatchUp();

    const userRes = await pool.query(
      `SELECT uuid, alias, email, phone, global_role FROM users WHERE uuid = $1`,
      [userUuid]
    );
    if (userRes.rows.length === 0) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const u = userRes.rows[0];

    const picks = pickableItemsForUser(getItems(), userUuid);
    const byPhase: Record<string, number> = {};
    const items = picks.map((p) => {
      byPhase[p.phase] = (byPhase[p.phase] ?? 0) + 1;
      const evt = p.eventId ? getEvent(p.eventId) : undefined;
      return { ...p, eventTitle: evt?.title ?? null };
    });

    res.status(200).json({
      user: {
        uuid: u.uuid,
        alias: u.alias,
        email: u.email ?? null,
        phone: u.phone ?? null,
        globalRole: toRole(u.global_role)
      },
      items,
      counts: { total: items.length, byPhase }
    });
  } catch (error) {
    console.error('Admin pickable items failed:', error);
    res.status(500).json({ error: 'Database error listing pickable items.' });
  }
};

/**
 * POST /api/admin/pickups/deliver
 * Body: { userUuid: string, itemIds: string[] }
 *
 * Procesa cada item en su propia transacción (aislamiento por item): un item
 * inválido no aborta los demás. Delega en `deliverItemByAdmin` con
 * `expectedUserUuid`, que exige que el usuario sea el titular de mayor prioridad
 * (en ventana libre, que tenga un claim activo). Emite SSE y audita por item.
 */
export const deliverBatch = async (req: Request, res: Response): Promise<void> => {
  const { userUuid, itemIds } = req.body ?? {};

  if (!userUuid || typeof userUuid !== 'string') {
    res.status(400).json({ error: 'userUuid is required.' });
    return;
  }
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    res.status(400).json({ error: 'itemIds must be a non-empty array.' });
    return;
  }

  const unique = Array.from(
    new Set(
      itemIds
        .filter((x: unknown) => typeof x === 'string' && x.trim().length > 0)
        .map((x: string) => x.trim())
    )
  );
  if (unique.length === 0) {
    res.status(400).json({ error: 'itemIds must contain at least one valid id.' });
    return;
  }
  if (unique.length > MAX_BATCH_ITEMS) {
    res.status(400).json({ error: `Too many items in one batch (max ${MAX_BATCH_ITEMS}).` });
    return;
  }

  try {
    await ensureHydrated();
    await runLazyCatchUp();

    const results: Array<Record<string, unknown>> = [];
    let deliveredCount = 0;

    for (const itemId of unique) {
      const outcome = await deliverItemByAdmin({ itemId, expectedUserUuid: userUuid });

      if (!outcome.ok) {
        results.push({ itemId, ok: false, code: outcome.code, message: outcome.message });
        continue;
      }

      deliveredCount++;
      const storeItem = getItemById(itemId);

      await logAudit({
        action: 'ITEM_DELIVERED',
        adminCodeSuffix: adminSuffix(req),
        itemId,
        userId: userUuid,
        details: {
          source: 'admin_pickup_batch',
          earlyPickup: outcome.earlyPickup,
          deliveredClaimId: outcome.deliveredClaimId,
          deliveredUsername: outcome.deliveredUsername,
          voidedCount: outcome.voided.length,
          phase: outcome.phase,
          timestamp: outcome.deliveredAt
        }
      });

      broadcastSseEvent('item_updated', {
        itemId,
        status: outcome.status,
        phase: outcome.phase,
        title: storeItem?.title ?? null,
        delivered: true,
        deliveredClaimId: outcome.deliveredClaimId,
        deliveredUsername: outcome.deliveredUsername,
        deliveredAt: outcome.deliveredAt,
        voided: outcome.voided,
        reason: 'delivered_by_admin'
      });

      results.push({
        itemId,
        ok: true,
        deliveredClaimId: outcome.deliveredClaimId,
        deliveredUsername: outcome.deliveredUsername,
        deliveredAt: outcome.deliveredAt
      });
    }

    res.status(200).json({
      success: true,
      userUuid,
      results,
      deliveredCount,
      failedCount: results.length - deliveredCount
    });
  } catch (error) {
    console.error('Admin batch deliver failed:', error);
    res.status(500).json({ error: 'Database error registering the deliveries.' });
  }
};
