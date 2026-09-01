/**
 * scripts/test-plan2.ts
 *
 * Functional test for Plan 2 (scheduler + queue auto-advance) run against the
 * configured Neon DB. Everything runs inside a single transaction that is
 * ROLLED BACK at the end, so no production data is modified.
 *
 * Coverage:
 *  1. assignPickupDeadlineToFirst assigns a deadline only to the first claim.
 *  2. advanceQueue after an expiry eviction: status mapping (2->waitlist_open),
 *     new first receives a fresh deadline, correct newFirstUsername.
 *  3. advanceQueue after a pickup: queue empties -> status 'available'.
 *
 * Run: npx tsx scripts/test-plan2.ts
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { assignPickupDeadlineToFirst, advanceQueue } from '../backend/src/services/queueService.js';

dotenv.config({ path: path.resolve('backend/.env') });

const pool = new Pool({
  user: process.env.DATABASE_USERNAME,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : 5432,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000
});

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- Fixtures (temp data, discarded on rollback) ---
    const stamp = Date.now();
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    await client.query('INSERT INTO users (uuid, alias) VALUES ($1, $2)', [u1, `plan2_u1_${stamp}`]);
    await client.query('INSERT INTO users (uuid, alias) VALUES ($1, $2)', [u2, `plan2_u2_${stamp}`]);

    const itemRes = await client.query(
      `INSERT INTO items (title, description, category, image_url, status)
       VALUES ($1, $2, 'Misc.', '', 'available')
       RETURNING id`,
      [`TEST-PLAN2-${stamp}`, 'temporary test item (rolled back)']
    );
    const itemId = itemRes.rows[0].id;

    // claim1 (first in line), claim2 (second in line)
    await client.query(
      `INSERT INTO claims (item_id, user_uuid, username, claimed_at)
       VALUES ($1, $2, 'plan2_u1', NOW())`,
      [itemId, u1]
    );
    await client.query(
      `INSERT INTO claims (item_id, user_uuid, username, claimed_at)
       VALUES ($1, $2, 'plan2_u2', NOW() + interval '1 second')`,
      [itemId, u2]
    );

    // --- Test 1: deadline only on the first claim ---
    console.log('Test 1: assignPickupDeadlineToFirst');
    await assignPickupDeadlineToFirst(itemId, client);
    const d1 = await client.query(
      'SELECT username, pickup_deadline FROM claims WHERE item_id = $1 ORDER BY claimed_at',
      [itemId]
    );
    check('first claim has pickup_deadline', d1.rows[0].pickup_deadline != null);
    check('second claim has NO pickup_deadline', d1.rows[1].pickup_deadline == null);
    check('first username is plan2_u1', d1.rows[0].username === 'plan2_u1');

    // --- Test 2: expiry eviction -> queue advances ---
    console.log('Test 2: advanceQueue after expiry eviction');
    await client.query('DELETE FROM claims WHERE item_id = $1 AND user_uuid = $2', [itemId, u1]);
    const adv1 = await advanceQueue(itemId, client);
    check('status -> waitlist_open (1 remaining)', adv1.newStatus === 'waitlist_open', adv1);
    check('new first is plan2_u2', adv1.newFirstUsername === `plan2_u2_${stamp}`, adv1);
    const d2 = await client.query(
      'SELECT username, pickup_deadline FROM claims WHERE item_id = $1 ORDER BY claimed_at',
      [itemId]
    );
    check('new first received fresh pickup_deadline', d2.rows[0].pickup_deadline != null);

    // --- Test 3: pickup -> queue empties ---
    console.log('Test 3: advanceQueue after pickup');
    await client.query('UPDATE claims SET picked_up = true, pickup_deadline = NULL WHERE item_id = $1', [
      itemId
    ]);
    const adv2 = await advanceQueue(itemId, client);
    check('status -> available (0 remaining)', adv2.newStatus === 'available', adv2);
    check('no new first username', adv2.newFirstUsername === null, adv2);

    // --- Rollback: nothing persists ---
    await client.query('ROLLBACK');
    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Test crashed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
