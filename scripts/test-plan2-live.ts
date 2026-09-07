/**
 * scripts/test-plan2-live.ts
 *
 * Live end-to-end test against a running backend (localhost:3000):
 *  - Creates a temporary user + item directly in Neon.
 *  - POST /api/claims  -> verifies the first claim receives a pickup_deadline.
 *  - POST /api/claims/pickup -> verifies the queue advances and the item returns
 *                               to 'available'.
 *  - Cleans up (deletes temp item + user).
 *
 * Requires the backend server to be running (node dist/index.js on :3000).
 * Run: npx tsx scripts/test-plan2-live.ts
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

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

const API = 'http://localhost:3000';
let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json() };
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const u1 = crypto.randomUUID();
  const alias = `plan2_live_${stamp}`;
  let itemId: string | null = null;

  try {
    // --- Fixtures ---
    await pool.query('INSERT INTO users (uuid, alias) VALUES ($1, $2)', [u1, alias]);
    const itemRes = await pool.query(
      `INSERT INTO items (title, description, category, image_urls, status)
       VALUES ($1, $2, 'Misc.', '[]'::jsonb, 'available') RETURNING id`,
      [`TEST-PLAN2-LIVE-${stamp}`, 'temporary live-test item']
    );
    itemId = itemRes.rows[0].id;

    // --- Claim via real endpoint ---
    const claim = await post('/api/claims', { itemId, userUuid: u1 });
    check('POST /api/claims -> 201', claim.status === 201, claim);
    check('queuePosition = 1', claim.data.queuePosition === 1, claim.data);

    const d = await pool.query('SELECT pickup_deadline FROM claims WHERE item_id = $1', [itemId]);
    check('first claim received pickup_deadline', d.rows[0]?.pickup_deadline != null, d.rows[0]);

    // --- Pickup via real endpoint ---
    const pickup = await post('/api/claims/pickup', { itemId, userUuid: u1 });
    check('POST /api/claims/pickup -> 200', pickup.status === 200, pickup);
    check('pickup advances to available', pickup.data.newStatus === 'available', pickup.data);
    check('no new first after pickup', pickup.data.newFirstUsername === null, pickup.data);

    const st = await pool.query('SELECT status FROM items WHERE id = $1', [itemId]);
    check('item status is available', st.rows[0].status === 'available', st.rows[0]);

    const picked = await pool.query(
      'SELECT picked_up FROM claims WHERE item_id = $1 AND user_uuid = $2',
      [itemId, u1]
    );
    check('claim marked picked_up', picked.rows[0]?.picked_up === true, picked.rows[0]);

    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    // --- Cleanup ---
    if (itemId) await pool.query('DELETE FROM items WHERE id = $1', [itemId]);
    await pool.query('DELETE FROM users WHERE uuid = $1', [u1]);
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Live test crashed:', err);
  process.exit(1);
});
