import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { removeClaimFromItem } from '../cache/appStore.js';
import { advanceQueue } from '../services/queueService.js';

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

    // Get the current alias of the user being evicted (for SSE broadcast)
    const userResult = await client.query('SELECT alias FROM users WHERE uuid = $1', [userUuid]);
    const username = userResult.rows[0]?.alias || 'unknown';

    // Remove the specific user from this item's claim ledger queue by userUuid
    const deleteQuery = `
      DELETE FROM claims 
      WHERE item_id = $1 AND user_uuid = $2
    `;
    await client.query(deleteQuery, [itemId, userUuid]);

    // Count remaining active claims (for audit)
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS active_count FROM claims WHERE item_id = $1',
      [itemId]
    );
    const remainingCount = countResult.rows[0].active_count;

    // Auto-advance the queue: recompute status + assign deadline to the new first
    const { newStatus, newFirstUsername } = await advanceQueue(itemId, client);

    await client.query('COMMIT');

    // Write-through: actualizar el store en RAM
    removeClaimFromItem(itemId, userUuid, newStatus);

    // Log audit entry
    await logAudit({
      action: 'CLAIM_EVICTED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: itemId,
      userId: userUuid,
      details: {
        username: username,
        remainingClaims: remainingCount,
        newStatus: newStatus,
        newFirstUsername: newFirstUsername,
        cascadedAutomatically: true,
        timestamp: new Date().toISOString()
      }
    });

    // Broadcast the eviction event via SSE
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: newStatus,
      userUuid: userUuid,
      username: username,
      evicted: true,
      evictedUsername: username,
      newFirstUsername,
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
