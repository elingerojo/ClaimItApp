import { Request, Response } from 'express';
import pool from '../config/db.js';

/**
 * Fetches all inventory items along with their sub-queues of claimants
 */
export const getInventoryFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Fetch all items
    const itemsResult = await pool.query('SELECT * FROM items ORDER BY created_at DESC');
    
    // 2. Fetch all current queue positions sorted chronologically
    const claimsResult = await pool.query('SELECT item_id, username, claimed_at FROM claims ORDER BY claimed_at ASC');
    
    // Group claims by their parent item_id using a clean accumulator block
    const claimsMap: Record<string, any[]> = {};
    claimsResult.rows.forEach(row => {
      if (!claimsMap[row.item_id]) {
        claimsMap[row.item_id] = [];
      }
      claimsMap[row.item_id].push({
        username: row.username,
        claimedAt: row.claimed_at
      });
    });

    // Structure a composite payload parsing individual lists inside items objects
    const responsePayload = itemsResult.rows.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      category: item.category,
      infoUrl: item.info_url,
      imageUrl: item.image_url,
      status: item.status,
      createdAt: item.created_at,
      queue: claimsMap[item.id] || []
    }));

    res.status(200).json(responsePayload);
  } catch (error) {
    console.error('Failed to retrieve inventory feed:', error);
    res.status(500).json({ error: 'Database processing error fetching item grid aggregates.' });
  }
};

/**
 * Fetches a rolling timeline ledger of the latest successful claims across the platform
 */
export const getLedgerFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    const queryText = `
      SELECT c.username, c.claimed_at, i.title, i.category
      FROM claims c
      JOIN items i ON c.item_id = i.id
      ORDER BY c.claimed_at DESC
      LIMIT 50
    `;
    const result = await pool.query(queryText);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Failed to retrieve activity logs:', error);
    res.status(500).json({ error: 'Database execution error generating historical ledger records.' });
  }
};
