import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import {
  addClaimToItem,
  appendLedger,
  refreshClaimDeadline,
  removeClaimFromItem
} from '../cache/appStore.js';
import { validateClaimInput, validateEmailFormat, validatePhoneFormat } from '@claimitapp/shared';
import { assignPickupDeadlineToFirst, advanceQueue } from '../services/queueService.js';
import { reduceExpirationCount } from '../services/trustSanctions.js';
import { runLazyCatchUp } from '../services/scheduler.js';

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

  // Catch-up perezoso antes de tocar la cola
  await runLazyCatchUp();

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 0. Resolve current alias from users table + blacklist check
    const userResult = await client.query(
      'SELECT alias, bloqueado_apartar FROM users WHERE uuid = $1',
      [userUuid]
    );
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'User not found. Please register your alias first.' });
      return;
    }
    if (userResult.rows[0].bloqueado_apartar) {
      await client.query('ROLLBACK');
      res.status(403).json({
        error: 'Tu cuenta está bloqueada para nuevas separaciones por exceder el umbral de expiraciones.'
      });
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
      SELECT id, status, title, category, event_id
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

    // 2a. Ciclo de vida del evento: en closing (claims_close_at) o closed
    //     (pickup_deadline) ya no se aceptan claims nuevos.
    if (item.event_id) {
      const evRes = await client.query(
        `SELECT status, claims_close_at, pickup_deadline
         FROM events WHERE id = $1`,
        [item.event_id]
      );
      const ev = evRes.rows[0];
      if (ev) {
        const nowMs = Date.now();
        const closeAt = ev.claims_close_at ? new Date(ev.claims_close_at).getTime() : null;
        const pickupAt = ev.pickup_deadline ? new Date(ev.pickup_deadline).getTime() : null;
        const claimsClosed =
          ev.status === 'closed' ||
          ev.status === 'closing' ||
          (closeAt !== null && closeAt <= nowMs) ||
          (pickupAt !== null && pickupAt <= nowMs);
        if (claimsClosed) {
          await client.query('ROLLBACK');
          res.status(409).json({
            error:
              'El evento ya no acepta nuevas separaciones (fase de recolección o cerrado).'
          });
          return;
        }
      }
    }

    // 2b. Límite de apartados simultáneos por rol (global: única fuente de verdad)
    if (item.event_id) {
      const userRoleRes = await client.query('SELECT global_role FROM users WHERE uuid = $1', [
        userUuid
      ]);
      const role = userRoleRes.rows[0]?.global_role || 'publico';

      const setting = await client.query(
        'SELECT max_apartados_simultaneos FROM trust_levels_settings WHERE id = $1',
        [role]
      );
      const limit = setting.rows[0]?.max_apartados_simultaneos ?? 1;

      const activeInEvent = await client.query(
        `SELECT COUNT(*)::int AS n FROM claims c
         JOIN items i ON c.item_id = i.id
         WHERE c.user_uuid = $1 AND COALESCE(c.picked_up, false) = false AND i.event_id = $2`,
        [userUuid, item.event_id]
      );

      if (activeInEvent.rows[0].n >= limit) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: `Límite de apartados simultáneos alcanzado (máximo ${limit} para tu rol en este evento).`
        });
        return;
      }
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

    // 5b. If this claim is first in line, assign its pickup deadline
    if (updatedCount === 1) {
      await assignPickupDeadlineToFirst(itemId, client);
    }

    // 6. Everything looks correct. Commit state payload to database.
    await client.query('COMMIT');

    // 6b. Write-through: actualizar el store en RAM (mismo await)
    const claimRes = await pool.query(
      `SELECT pickup_deadline, role_at_assignment, pickup_window_hours
       FROM claims WHERE item_id = $1 AND user_uuid = $2`,
      [itemId, userUuid]
    );
    addClaimToItem(
      itemId,
      {
        userUuid,
        username,
        claimedAt: newClaim.claimed_at,
        pickupDeadline: claimRes.rows[0]?.pickup_deadline ?? null,
        roleAtAssignment: claimRes.rows[0]?.role_at_assignment ?? null,
        pickupWindowHours:
          claimRes.rows[0]?.pickup_window_hours != null
            ? Number(claimRes.rows[0].pickup_window_hours)
            : null
      },
      newStatus
    );
    appendLedger({
      user_uuid: userUuid,
      username,
      claimed_at: newClaim.claimed_at,
      title: item.title,
      category: item.category
    });

    // Broadcast real-time message with userUuid for precise frontend matching
    broadcastSseEvent('item_updated', {
      itemId: itemId,
      status: newStatus,
      userUuid: userUuid,
      username: username,
      queuePosition: updatedCount,
      title: item.title,
      category: item.category,
      claimedAt: newClaim.claimed_at,
      pickupDeadline: claimRes.rows[0]?.pickup_deadline ?? null
    });

    res.status(201).json({
      success: true,
      message: updatedCount === 1 ? 'Item claimed successfully!' : `Joined waitlist at spot #${updatedCount}.`,
      queuePosition: updatedCount,
      claimId: newClaim.id,
      // Deadline congelado del nuevo primero en fila (F1) para feedback inmediato.
      pickupDeadline: claimRes.rows[0]?.pickup_deadline ?? null,
      roleAtAssignment: claimRes.rows[0]?.role_at_assignment ?? null,
      pickupWindowHours:
        claimRes.rows[0]?.pickup_window_hours != null
          ? Number(claimRes.rows[0].pickup_window_hours)
          : null
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Transaction execution failed:', error);
    res.status(500).json({ error: 'Internal system error processing the claim transaction.' });
  } finally {
    client.release();
  }
};

/**
 * POST /api/claims/pickup
 *
 * Confirms that the user picked up the item: marks the claim as picked_up,
 * clears its deadline and auto-advances the queue (FIFO) so the next claimant
 * (if any) becomes first and receives a fresh pickup deadline.
 */
export const confirmPickup = async (req: Request, res: Response): Promise<void> => {
  const { itemId, userUuid } = req.body;

  if (!itemId || !userUuid) {
    res.status(400).json({ error: 'itemId and userUuid are required.' });
    return;
  }

  // Catch-up perezoso antes de confirmar recogida
  await runLazyCatchUp();

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the target item row to prevent race conditions
    const itemLock = await client.query(
      'SELECT id, event_id FROM items WHERE id = $1 FOR UPDATE',
      [itemId]
    );
    const targetEventId = itemLock.rows[0]?.event_id ?? null;

    // Find the active (not picked up) claim for this user on this item
    const claimResult = await client.query(
      `SELECT id, username FROM claims
       WHERE item_id = $1 AND user_uuid = $2 AND COALESCE(picked_up, false) = false`,
      [itemId, userUuid]
    );

    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'No active claim found for this item and user.' });
      return;
    }

    const claim = claimResult.rows[0];

    // Mark as picked up and clear its deadline
    await client.query('UPDATE claims SET picked_up = true, pickup_deadline = NULL WHERE id = $1', [
      claim.id
    ]);

    // Auto-advance the queue: next claim (if any) becomes first with a deadline
    const { newStatus, newFirstUsername, newFirstUuid, newFirstPickupDeadline } = await advanceQueue(
      itemId,
      client
    );

    // Tolerancia: completar a tiempo reduce el contador de expiraciones
    if (targetEventId) {
      await reduceExpirationCount(targetEventId, userUuid, client);
    }

    await client.query('COMMIT');

    // Write-through: remove the picked-up user from the RAM store queue and
    // refresh the frozen deadline of the new first-in-line (if any).
    removeClaimFromItem(itemId, userUuid, newStatus);
    if (newFirstUuid) {
      refreshClaimDeadline(itemId, newFirstUuid, newFirstPickupDeadline ?? null);
    }

    // Broadcast with pickup context
    broadcastSseEvent('item_updated', {
      itemId,
      status: newStatus,
      userUuid,
      username: claim.username,
      pickedUp: true,
      newFirstUsername,
      newFirstUuid,
      newFirstPickupDeadline,
      reason: 'pickup_confirmed'
    });

    res.status(200).json({
      success: true,
      message: 'Pickup confirmed. Queue advanced.',
      newStatus,
      newFirstUsername,
      newFirstPickupDeadline
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Pickup confirmation failed:', error);
    res.status(500).json({ error: 'Internal error confirming pickup.' });
  } finally {
    client.release();
  }
};
