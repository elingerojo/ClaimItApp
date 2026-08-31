import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import { validateClaimInput, validateEmailFormat, validatePhoneFormat } from '@claimitapp/shared';

export const createClaim = async (req: Request, res: Response): Promise<void> => {
  const { itemId, userUuid, email, phone } = req.body;

  // Validation: userUuid and Item ID are strictly required
  const validation = validateClaimInput({ itemId, userUuid, email, phone });
  if (!validation.valid) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Additional validation for email and phone if provided
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

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 0. Resolve current alias from users table
    const userResult = await client.query(
      'SELECT alias FROM users WHERE uuid = $1',
      [userUuid]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'User not found. Please register your alias first.' });
      return;
    }
    const username = userResult.rows[0].alias;

    // 1. Check if this user already has a claim on this item (by userUuid)
    const existingClaimQuery = `
      SELECT id FROM claims 
      WHERE item_id = $1 AND user_uuid = $2
      LIMIT 1
    `;
    const existingClaimResult = await client.query(existingClaimQuery, [itemId, userUuid]);

    if (existingClaimResult.rows.length > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: `Ya estás en la lista de este objeto.` });
      return;
    }

    // 2. Fetch the parent item and apply an exclusive pessimistic row lock
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

    // 3. Count current active queue rows for this target item
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

    // 4. Insert new claim line into ledger with userUuid and denormalized username (current alias)
    const insertClaimQuery = `
      INSERT INTO claims (item_id, user_uuid, username, claimant_email, claimant_phone) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING id, claimed_at
    `;
    const newClaimResult = await client.query(insertClaimQuery, [
      itemId, userUuid, username, email || null, phone || null
    ]);
    const newClaim = newClaimResult.rows[0];

    // 5. Update operational item lifecycle state mapping
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

    // 6. Everything looks correct. Commit state payload to database.
    await client.query('COMMIT');

    // Broadcast real-time message with userUuid for precise frontend matching
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: newStatus,
      userUuid: userUuid,
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
