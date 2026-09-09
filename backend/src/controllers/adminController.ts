import { Request, Response } from 'express';
import { broadcastSseEvent } from '../config/sse.js';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { getItemById } from '../cache/appStore.js';
import { adminEvictClaim, deliverItemByAdmin } from '../services/queueService.js';
import { runLazyCatchUp } from '../services/scheduler.js';

/**
 * POST /api/admin/items/:id/deliver — ADMIN marca 'item recogido' (v2, D6)
 *
 * Con row-lock sobre el item: valida que haya un titular de turno activo
 * (pickup_turns) o una ventana libre (con claim opcional); fija
 * phase='entregado' + delivered_claim_id/delivered_at, conserva la cola como
 * registro forense (void a los demás activos, sin sanción) y DETIENE los
 * workflows automáticos restantes (la fase 'entregado' ya no progresa). Emite
 * SSE 'item_updated' reason='delivered_by_admin' y audita.
 *
 * Body opcional: { claimId } para marcar un claim concreto de la ventana libre.
 */
export const deliverItem = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const adminSession = (req as any).adminSession;
  const { claimId } = req.body ?? {};

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  // Catch-up: que el reloj (expirios / ventana libre) esté al día antes de entregar.
  await runLazyCatchUp();

  try {
    const outcome = await deliverItemByAdmin({ itemId: id, claimId: claimId ?? null });

    if (!outcome.ok) {
      const status = outcome.code === 'not_found' ? 404 : outcome.code === 'invalid_claim' ? 400 : 409;
      res.status(status).json({
        error: outcome.message,
        code: outcome.code,
        timestamp: new Date().toISOString()
      });
      return;
    }

    const storeItem = getItemById(id);

    await logAudit({
      action: 'ITEM_DELIVERED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: id,
      details: {
        deliveredClaimId: outcome.deliveredClaimId,
        deliveredUsername: outcome.deliveredUsername,
        voidedCount: outcome.voided.length,
        phase: outcome.phase,
        timestamp: outcome.deliveredAt
      }
    });

    broadcastSseEvent('item_updated', {
      itemId: id,
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

    res.status(200).json({
      success: true,
      message: 'Item marcado como recogido (entregado). Workflows detenidos; cola conservada como forense.',
      itemId: id,
      phase: outcome.phase,
      deliveredClaimId: outcome.deliveredClaimId,
      deliveredUsername: outcome.deliveredUsername,
      deliveredAt: outcome.deliveredAt,
      voided: outcome.voided
    });
  } catch (error) {
    console.error('Admin deliver routine failed:', error);
    res.status(500).json({ error: 'Database execution failure marking the item as delivered.' });
  }
};

/**
 * POST /api/admin/evict — expulsa a un claimant de la cola (v2, sin sanción).
 * El claim activo pasa a 'void' (forense) y la cola se recompone; si era el
 * titular y no quedan activos, abre la ventana libre en este instante.
 */
export const evictClaimant = async (req: Request, res: Response): Promise<void> => {
  const adminSession = (req as any).adminSession;
  const { itemId, userUuid } = req.body;

  if (!itemId || !userUuid) {
    res.status(400).json({ error: 'Missing required parameters: itemId and userUuid.' });
    return;
  }

  try {
    const outcome = await adminEvictClaim(itemId, userUuid);

    if (!outcome.ok) {
      const status = outcome.code === 'not_found' ? 404 : 409;
      res.status(status).json({
        error: outcome.message,
        code: outcome.code,
        timestamp: new Date().toISOString()
      });
      return;
    }

    await logAudit({
      action: 'CLAIM_EVICTED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: itemId,
      userId: userUuid,
      details: {
        username: outcome.username,
        claimState: outcome.claimState,
        phase: outcome.phase,
        freeWindowOpenedAt: outcome.freeWindowOpenedAt,
        timestamp: new Date().toISOString()
      }
    });

    broadcastSseEvent('item_updated', {
      itemId,
      status: outcome.status,
      phase: outcome.phase,
      userUuid,
      username: outcome.username,
      evicted: true,
      evictedUsername: outcome.username,
      claimState: outcome.claimState,
      freeWindowOpenedAt: outcome.freeWindowOpenedAt,
      reason: 'manual_evict'
    });

    res.status(200).json({
      success: true,
      message: 'Claimant evicted successfully and queue recomposed.',
      phase: outcome.phase,
      claimState: outcome.claimState
    });
  } catch (error) {
    console.error('Admin eviction routine failed:', error);
    res.status(500).json({ error: 'Database execution failure managing admin eviction cascade.' });
  }
};
