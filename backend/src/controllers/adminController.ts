import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';

export const evictClaimant = async (req: Request, res: Response): Promise<void> => {
  const adminToken = req.headers['x-admin-token'];
  const { itemId, userUuid } = req.body;

  if (adminToken !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized administrative access.' });
    return;
  }

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

    // Count remaining active claims
    const countQuery = 'SELECT COUNT(*) as active_count FROM claims WHERE item_id = $1';
    const countResult = await client.query(countQuery, [itemId]);
    const remainingCount = parseInt(countResult.rows[0].active_count, 10);

    // Map the new operational lifecycle status
    let newStatus = 'available';
    if (remainingCount === 1 || remainingCount === 2) {
      newStatus = 'waitlist_open';
    } else if (remainingCount >= 3) {
      newStatus = 'unavailable';
    }

    const updateStatusQuery = 'UPDATE items SET status = $1 WHERE id = $2';
    await client.query(updateStatusQuery, [newStatus, itemId]);

    await client.query('COMMIT');

    // Broadcast the eviction event via SSE
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: newStatus,
      userUuid: userUuid,
      username: username,
      evicted: true,
      queuePosition: remainingCount
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
