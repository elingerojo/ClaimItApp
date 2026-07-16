import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';

export const createClaim = async (req: Request, res: Response): Promise<void> => {
  const { itemId, username, email, phone } = req.body;

  // Validation: Username and Item ID are strictly required
  if (!itemId || !username) {
    res.status(400).json({ error: 'Missing required fields: itemId and username.' });
    return;
  }

  const client = await pool.connect();

  try {
    // 1. Open the atomic isolation transaction
    await client.query('BEGIN');

    // 2. Username Collision Guard Check
    // If the username exists, ensure the incoming contact details match historical records
    const userCheckQuery = `
      SELECT claimant_email, claimant_phone 
      FROM claims 
      WHERE LOWER(username) = LOWER($1) 
      LIMIT 1
    `;
    const userCheckResult = await client.query(userCheckQuery, [username]);
    
    if (userCheckResult.rows.length > 0) {
      const existingUser = userCheckResult.rows[0];
      
      // If they provided contact info that conflicts with the first time they claimed an item
      if (
        (email && existingUser.claimant_email && email !== existingUser.claimant_email) ||
        (phone && existingUser.claimant_phone && phone !== existingUser.claimant_phone)
      ) {
        await client.query('ROLLBACK');
        res.status(409).json({ 
          error: `The username "${username}" is already taken by someone else. Please choose a unique nickname.` 
        });
        return;
      }
    }

    // 3. Fetch the parent item and apply an exclusive pessimistic row lock
    const itemCheckQuery = `
      SELECT id, status, title, category
      FROM items
      WHERE id = $1
      FOR UPDATE
    `;
    const itemResult = await client.query(itemCheckQuery, [itemId]);

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const item = itemResult.rows[0];

    if (item.status === 'unavailable') {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'The waitlist for this item is completely full.' });
      return;
    }

    // 4. Count current active queue rows for this target item
    const countClaimsQuery = `
      SELECT COUNT(*) as current_claims 
      FROM claims 
      WHERE item_id = $1
    `;
    const countResult = await client.query(countClaimsQuery, [itemId]);
    const currentClaimsCount = parseInt(countResult.rows[0].current_claims, 10);

    if (currentClaimsCount >= 3) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'The waitlist for this item is completely full.' });
      return;
    }

    // 5. Insert new claim line into ledger with optional contact details
    const insertClaimQuery = `
      INSERT INTO claims (item_id, username, claimant_email, claimant_phone) 
      VALUES ($1, $2, $3, $4) 
      RETURNING id, claimed_at
    `;
    const newClaimResult = await client.query(insertClaimQuery, [itemId, username, email || null, phone || null]);
    const newClaim = newClaimResult.rows[0];

    // 6. Update operational item lifecycle state mapping
    const updatedCount = currentClaimsCount + 1;
    let newStatus = 'available';

    if (updatedCount === 1 || updatedCount === 2) {
      newStatus = 'waitlist_open';
    } else if (updatedCount === 3) {
      newStatus = 'unavailable';
    }

    const updateItemStatusQuery = `
      UPDATE items 
      SET status = $1 
      WHERE id = $2
    `;
    await client.query(updateItemStatusQuery, [newStatus, itemId]);

    // 7. Everything looks correct. Commit state payload to database.
    await client.query('COMMIT');
    
    // Broadcast real-time message out to all open streaming contexts instantly
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: newStatus,
      username: username,
      queuePosition: updatedCount,
      title: item.title,
      category: item.category,
      claimedAt: newClaim.claimed_at
    });

    res.status(201).json({
      success: true,
      message: updatedCount === 1 ? 'Item claimed successfully!' : `Joined waitlist at spot #${updatedCount}.`,
      queuePosition: updatedCount,
      claimId: newClaim.id
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Transaction execution failed:', error);
    res.status(500).json({ error: 'Internal system error processing the claim transaction.' });
  } finally {
    client.release();
  }
};
