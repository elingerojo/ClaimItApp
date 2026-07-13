import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';

export const evictClaimant = async (req: Request, res: Response): Promise<void> => {
  const adminToken = req.headers['x-admin-token'];
  const { itemId, username } = req.body;

  if (adminToken !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized administrative access.' });
    return;
  }

  if (!itemId || !username) {
    res.status(400).json({ error: 'Missing required parameters: itemId and username.' });
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock the target item row to prevent race conditions during cascade recalculation
    await client.query('SELECT id FROM items WHERE id = $1 FOR UPDATE', [itemId]);

    // 2. Remove the specific target user from this item's claim ledger queue
    const deleteQuery = `
      DELETE FROM claims 
      WHERE item_id = $1 AND LOWER(username) = LOWER($2)
    `;
    await client.query(deleteQuery, [itemId, username]);

    // 3. Count remaining active claims left in line for this item
    const countQuery = 'SELECT COUNT(*) as active_count FROM claims WHERE item_id = $1';
    const countResult = await client.query(countQuery, [itemId]);
    const remainingCount = parseInt(countResult.rows[0].active_count, 10);

    // 4. Map the new operational lifecycle status enum state based on remaining count
    let newStatus = 'available';
    if (remainingCount === 1 || remainingCount === 2) {
      newStatus = 'waitlist_open';
    } else if (remainingCount >= 3) {
      newStatus = 'unavailable';
    }

    const updateStatusQuery = 'UPDATE items SET status = $1 WHERE id = $2';
    await client.query(updateStatusQuery, [newStatus, itemId]);

    await client.query('COMMIT');

    // 5. Broadcast the eviction event via SSE to trigger instant updates across all browsers
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: newStatus,
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
