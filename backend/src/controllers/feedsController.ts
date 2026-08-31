import { Request, Response } from 'express';
import pool from '../config/db.js';
import { ROLE_HIERARCHY, canUserSeeItem } from '@claimitapp/shared';

/**
 * Fetches inventory items filtered by user's role and visibility_level
 * Visibility hierarchy: 0=admin, 1=familiares, 2=amigos, 3=conocidos, 4=publico
 * User can see items with visibility_level >= their role level
 */
export const getInventoryFeed = async (req: Request, res: Response): Promise<void> => {
  try {
    const userUuid = req.query.userUuid as string;
    let userRole = 'publico'; // Default for unauthenticated users

    // If userUuid provided, get their actual global_role
    if (userUuid) {
      const userResult = await pool.query(
        'SELECT global_role FROM users WHERE uuid = $1',
        [userUuid]
      );
      if (userResult.rows.length > 0) {
        userRole = userResult.rows[0].global_role;
      }
    }

    const userRoleLevel = ROLE_HIERARCHY[userRole] || ROLE_HIERARCHY.publico;

    // 1. Fetch all items, with role-based filtering
    const itemsResult = await pool.query(
      `SELECT * FROM items 
       WHERE visibility_level IS NULL OR visibility_level >= $1
       ORDER BY created_at DESC`,
      [userRoleLevel]
    );

    // 2. Fetch all current queue positions with userUuid and current alias (via JOIN)
    const claimsResult = await pool.query(`
      SELECT c.item_id, c.user_uuid, u.alias AS username, c.claimed_at
      FROM claims c
      JOIN users u ON c.user_uuid = u.uuid
      ORDER BY c.claimed_at ASC
    `);

    // Group claims by their parent item_id
    const claimsMap: Record<string, any[]> = {};
    claimsResult.rows.forEach(row => {
      if (!claimsMap[row.item_id]) {
        claimsMap[row.item_id] = [];
      }
      claimsMap[row.item_id].push({
        userUuid: row.user_uuid,
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
      visibilityLevel: item.visibility_level || 4, // Default to public
      eventId: item.event_id || null,
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
      SELECT c.user_uuid, u.alias AS username, c.claimed_at, i.title, i.category
      FROM claims c
      JOIN items i ON c.item_id = i.id
      JOIN users u ON c.user_uuid = u.uuid
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
