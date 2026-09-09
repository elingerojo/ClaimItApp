import { Request, Response } from 'express';
import { validateClaimInput, validateEmailFormat, validatePhoneFormat } from '@claimitapp/shared';
import { broadcastSseEvent } from '../config/sse.js';
import { appendLedger, getItemById } from '../cache/appStore.js';
import { claimItem, voluntarilyLeaveItem, type ClaimOutcome } from '../services/queueService.js';
import { runLazyCatchUp } from '../services/scheduler.js';

function claimErrorHttp(code: string): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'blocked':
      return 403;
    default:
      return 409;
  }
}

/**
 * POST /api/claims — "Lo quiero" (v2)
 *
 * - phase='claim_open' (evento active, now dentro de [claim_from(rol),
 *   claims_close_at)) y cola < 3 → se une a la FIFO (respuesta con
 *   fifo_position). Rechaza si el item ya quedó congelado (pickup_turns):
 *   solo queda esperar la ventana libre.
 * - phase='ventana_libre' → captura directa: entrega inmediata (phase
 *   entregado, delivered_claim_id/delivered_at). No cuenta en
 *   max_apartados_simultaneos, no dispara sanción.
 *
 * Todos los gates de fase/rol/límites se validan de forma transaccional dentro
 * de queueService.claimItem (row-lock FOR UPDATE; el primero gana).
 */
export const createClaim = async (req: Request, res: Response): Promise<void> => {
  const { itemId, userUuid, email, phone } = req.body;

  const validation = validateClaimInput({ itemId, userUuid, email, phone });
  if (!validation.valid) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
    return;
  }
  if (email && email.trim() && !validateEmailFormat(email)) {
    res.status(400).json({
      error: 'Validation failed',
      details: ['Email: invalid format'],
      timestamp: new Date().toISOString()
    });
    return;
  }
  if (phone && phone.trim() && !validatePhoneFormat(phone)) {
    res.status(400).json({
      error: 'Validation failed',
      details: ['Phone: must be 7-15 digits'],
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Catch-up perezoso: si T_inicio pasó, el item debe congelarse antes de que el
  // claim siguiente se resuelva (un claim_open vencido pasa a ventana libre).
  await runLazyCatchUp();

  try {
    const outcome = await claimItem({ itemId, userUuid, email, phone } as any);

    if (!outcome.ok) {
      res.status(claimErrorHttp(outcome.code)).json({
        error: outcome.message,
        code: outcome.code,
        timestamp: new Date().toISOString()
      });
      return;
    }

    const storeItem = getItemById(itemId);
    const title = storeItem?.title ?? null;
    const category = storeItem?.category ?? null;

    if (outcome.kind === 'fifo') {
      const myClaim = storeItem?.queue.find((c) => c.id === outcome.claimId);
      const username = myClaim?.username ?? userUuid;
      const claimedAt = outcome.claimedAt;

      // Ledger / feed de actividad (write-through RAM).
      appendLedger({ user_uuid: userUuid, username, claimed_at: claimedAt, title: title ?? '', category: category ?? '' });

      broadcastSseEvent('item_updated', {
        itemId,
        status: outcome.status,
        phase: outcome.phase,
        userUuid,
        username,
        claimId: outcome.claimId,
        queuePosition: outcome.fifoPosition,
        title,
        category,
        claimedAt,
        reason: 'claim_created'
      });

      const first = outcome.fifoPosition === 1;
      res.status(201).json({
        success: true,
        message: first ? 'Item claimed successfully!' : `Joined waitlist at spot #${outcome.fifoPosition}.`,
        queuePosition: outcome.fifoPosition,
        fifoPosition: outcome.fifoPosition,
        claimId: outcome.claimId,
        phase: outcome.phase,
        status: outcome.status
      });
      return;
    }

    // free_window_capture
    const myClaim = storeItem?.queue.find((c) => c.id === outcome.claimId);
    const username = myClaim?.username ?? userUuid;
    appendLedger({
      user_uuid: userUuid,
      username,
      claimed_at: outcome.claimedAt,
      title: title ?? '',
      category: category ?? ''
    });

    broadcastSseEvent('item_updated', {
      itemId,
      status: outcome.status,
      phase: outcome.phase,
      userUuid,
      username,
      claimId: outcome.claimId,
      claimedAt: outcome.claimedAt,
      deliveredClaimId: outcome.deliveredClaimId,
      deliveredAt: outcome.deliveredAt,
      title,
      category,
      reason: 'ventana_libre_capture'
    });

    res.status(201).json({
      success: true,
      message: '¡Reclamado! Te llevas este objeto (ventana libre).',
      delivered: true,
      claimId: outcome.claimId,
      deliveredClaimId: outcome.deliveredClaimId,
      deliveredAt: outcome.deliveredAt,
      phase: outcome.phase,
      status: outcome.status
    });
  } catch (error) {
    console.error('Claim transaction failed:', error);
    res.status(500).json({ error: 'Internal system error processing the claim transaction.' });
  }
};

/**
 * POST /api/claims/pickup — OBSOLETO en v2.
 * La entrega la marca el ADMIN (POST /api/admin/items/:id/deliver). Este stub
 * responde 410 para que un cliente legacy reciba un error claro.
 */
export const confirmPickup = async (_req: Request, res: Response): Promise<void> => {
  res.status(410).json({
    error:
      'El flujo de recogida cambió en la Estrategia v2: la entrega la marca el ADMIN (POST /api/admin/items/:id/deliver).'
  });
};

/**
 * POST /api/claims/leave — "Ya no lo quiero" (v2, dominó NEUTRO)
 *
 * - claim_open (pre-congelamiento): libera la posición (neutral).
 * - pickup_turns: el TITULAR activo dispara el dominó (la siguiente posición
 *   activa hereda su V fijo; si no hay más activos se abre la ventana libre en
 *   este instante). Un no-titular activo se marca cancelado_voluntario (neutral)
 *   y la cola se recompone sola.
 * - No se puede dejar un claim de un item ya entregado / enviado a caridad.
 * NUNCA aplica sanción (el expirio sí).
 */
export const leaveClaim = async (req: Request, res: Response): Promise<void> => {
  const { itemId, userUuid } = req.body;

  if (!itemId || !userUuid) {
    res.status(400).json({ error: 'itemId and userUuid are required.' });
    return;
  }

  await runLazyCatchUp();

  try {
    const outcome = await voluntarilyLeaveItem(itemId, userUuid);

    if (!outcome.ok) {
      const status = outcome.code === 'not_found' ? 404 : 409;
      res.status(status).json({
        error: outcome.message,
        code: outcome.code,
        timestamp: new Date().toISOString()
      });
      return;
    }

    const storeItem = getItemById(itemId);
    broadcastSseEvent('item_updated', {
      itemId,
      status: outcome.status,
      phase: outcome.phase,
      userUuid,
      username: outcome.username,
      // Datos del item para que el feed de actividad en vivo pueda renderizar
      // "@usuario liberó \"Título\"" (antes llegaba sin título y mostraba "").
      title: storeItem?.title ?? null,
      category: storeItem?.category ?? null,
      releasedAt: new Date().toISOString(),
      claimState: outcome.claimState,
      freeWindowOpenedAt: outcome.freeWindowOpenedAt,
      reason: 'user_left_voluntarily'
    });

    res.status(200).json({
      success: true,
      message: 'Has salido de la lista. Tu lugar quedó liberado (sin sanción).',
      claimState: outcome.claimState,
      phase: outcome.phase,
      status: outcome.status,
      freeWindowOpenedAt: outcome.freeWindowOpenedAt
    });
  } catch (error) {
    console.error('Leave claim transaction failed:', error);
    res.status(500).json({ error: 'Internal error removing the claim.' });
  }
};
