import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { refreshClaimDeadline, removeClaimFromItem } from '../cache/appStore.js';
import { removeActiveClaimAndCascade } from '../services/queueService.js';

export const evictClaimant = async (req: Request, res: Response): Promise<void> => {
  const adminSession = (req as any).adminSession; // Attached by requireAdminSession middleware
  const { itemId, userUuid } = req.body;

  if (!itemId || !userUuid) {
    res.status(400).json({ error: 'Missing required parameters: itemId and userUuid.' });
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the target item row to prevent race conditions
    await client.query('SELECT id FROM items WHERE id = $1 FOR UPDATE', [itemId]);

    // Remove the ACTIVE claim (no picked_up) y recompone la cola (estatus +
    // deadline del nuevo #1) vía el helper compartido con leaveClaim.
    const result = await removeActiveClaimAndCascade(itemId, userUuid, client);

    if (!result.found) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'No active claim found for this item and user.' });
      return;
    }

    // Count remaining active claims (for audit)
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS active_count FROM claims
       WHERE item_id = $1 AND COALESCE(picked_up, false) = false`,
      [itemId]
    );
    const remainingCount = countResult.rows[0].active_count;

    await client.query('COMMIT');

    // Write-through: actualizar el store en RAM + refrescar deadline del nuevo primero
    removeClaimFromItem(itemId, userUuid, result.newStatus);
    if (result.newFirstUuid) {
      refreshClaimDeadline(itemId, result.newFirstUuid, result.newFirstPickupDeadline ?? null);
    }

    // Log audit entry
    await logAudit({
      action: 'CLAIM_EVICTED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: itemId,
      userId: userUuid,
      details: {
        username: result.username,
        remainingClaims: remainingCount,
        newStatus: result.newStatus,
        newFirstUsername: result.newFirstUsername,
        cascadedAutomatically: true,
        timestamp: new Date().toISOString()
      }
    });

    // Broadcast the eviction event via SSE
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: result.newStatus,
      userUuid: userUuid,
      username: result.username,
      evicted: true,
      evictedUsername: result.username,
      newFirstUsername: result.newFirstUsername,
      newFirstUuid: result.newFirstUuid,
      newFirstPickupDeadline: result.newFirstPickupDeadline,
      queuePosition: remainingCount,
      reason: 'manual_evict'
    });

    res.status(200).json({ success: true, message: 'Claimant evicted successfully and list cascaded.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin eviction routine failed:', error);
    res.status(500).json({ error: 'Database execution failure managing admin eviction cascade.' });
  } finally {
    client.release();
  }
};
