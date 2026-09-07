/**
 * scripts/test-plan5.ts
 *
 * Functional test for Plan 5 (trust-level price matrix + apartado limits):
 *  1. createItem freezes the 4 per-role prices from a single base cost.
 *  2. GET /api/items returns only the price of the user's role (precioVisible).
 *  3. createClaim enforces max_apartados_simultaneos per role within an event.
 * Runs against Neon with temp fixtures, cleaned up at the end.
 *
 * Run: npx tsx scripts/test-plan5.ts
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../backend/src/config/db.js';
import { createItem } from '../backend/src/controllers/itemsController.js';
import { createClaim } from '../backend/src/controllers/claimsController.js';
import { getInventoryFeed } from '../backend/src/controllers/feedsController.js';
import { upsertUser } from '../backend/src/cache/appStore.js';

dotenv.config({ path: path.resolve('backend/.env') });

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

function mockReq(overrides: Record<string, any> = {}): any {
  return { params: {}, query: {}, body: {}, headers: {}, ...overrides };
}
function mockRes(): any {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => {
    res._status = code;
    return res;
  };
  res.json = (body: any) => {
    res._json = body;
    return res;
  };
  return res;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const t0 = new Date();
  const famUuid = crypto.randomUUID();
  const pubUuid = crypto.randomUUID();
  const owner = crypto.randomUUID();
  let pricedItemId: string | null = null;
  let eventId: string | null = null;
  let item1: string | null = null;
  let item2: string | null = null;

  try {
    // --- 1. createItem freezes the price snapshot ---
    console.log('Test 1: createItem price snapshot');
    upsertUser({ uuid: famUuid, alias: `plan5_fam_${stamp}`, global_role: 'familiares' });
    upsertUser({ uuid: pubUuid, alias: `plan5_pub_${stamp}`, global_role: 'publico' });

    const createRes = mockRes();
    await createItem(
      mockReq({
        body: {
          title: `Plan5 Item ${stamp}`,
          description: 'temporary priced item for plan5 test',
          category: 'Misc.',
          infoUrl: null,
          imageUrls: ['https://example.com/x.jpg'],
          precio_base_costo: 100
        }
      }),
      createRes
    );
    check('createItem -> 201', createRes._status === 201, createRes._json);
    pricedItemId = createRes._json?.item?.id;

    const row = await pool.query(
      `SELECT precio_familiar, precio_amigo, precio_conocido, precio_publico
       FROM items WHERE id = $1`,
      [pricedItemId]
    );
    check('precio_familiar = 70 (0.70)', Number(row.rows[0]?.precio_familiar) === 70, row.rows[0]);
    check('precio_amigo = 85 (0.85)', Number(row.rows[0]?.precio_amigo) === 85, row.rows[0]);
    check('precio_conocido = 95 (0.95)', Number(row.rows[0]?.precio_conocido) === 95, row.rows[0]);
    check('precio_publico = 100 (1.00)', Number(row.rows[0]?.precio_publico) === 100, row.rows[0]);

    // --- 2. Feed returns only the price of the user's role ---
    console.log('Test 2: feed precioVisible per role');
    const famFeed = mockRes();
    await getInventoryFeed(mockReq({ query: { userUuid: famUuid } }), famFeed);
    const famItem = (famFeed._json as any[]).find(i => i.id === pricedItemId);
    check('familiares sees 70', famItem?.precioVisible === 70, famItem);

    const pubFeed = mockRes();
    await getInventoryFeed(mockReq({ query: { userUuid: pubUuid } }), pubFeed);
    const pubItem = (pubFeed._json as any[]).find(i => i.id === pricedItemId);
    check('publico sees 100', pubItem?.precioVisible === 100, pubItem);

    // --- 3. max_apartados_simultaneos per role (publico=1, familiares=15) ---
    console.log('Test 3: apartado limits');
    await pool.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
      owner,
      `plan5_owner_${stamp}`,
      'familiares'
    ]);
    await pool.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
      pubUuid,
      `plan5_pub_${stamp}`,
      'publico'
    ]);
    const evRes = await pool.query(
      `INSERT INTO events (title, available_from, pickup_deadline)
       VALUES ($1, NOW() + interval '1 hour', NOW() + interval '3 days')
       RETURNING id`,
      [`Plan5 Event ${stamp}`]
    );
    eventId = evRes.rows[0].id;

    const i1 = await pool.query(
      `INSERT INTO items (title, description, category, image_urls, status, event_id)
       VALUES ($1, $2, 'Misc.', '[]'::jsonb, 'available', $3) RETURNING id`,
      [`TEST-PLAN5-1-${stamp}`, 'temp item 1', eventId]
    );
    item1 = i1.rows[0].id;
    const i2 = await pool.query(
      `INSERT INTO items (title, description, category, image_urls, status, event_id)
       VALUES ($1, $2, 'Misc.', '[]'::jsonb, 'available', $3) RETURNING id`,
      [`TEST-PLAN5-2-${stamp}`, 'temp item 2', eventId]
    );
    item2 = i2.rows[0].id;

    // publico (limit 1): first claim OK
    const c1 = mockRes();
    await createClaim(mockReq({ body: { itemId: item1, userUuid: pubUuid } }), c1);
    check('publico claim #1 -> 201', c1._status === 201, c1._json);

    // publico (limit 1): second claim in same event -> 409
    const c2 = mockRes();
    await createClaim(mockReq({ body: { itemId: item2, userUuid: pubUuid } }), c2);
    check('publico claim #2 -> 409 (limit)', c2._status === 409, c2._json);

    // familiares (limit 15): can claim another item in the same event
    const c3 = mockRes();
    await createClaim(mockReq({ body: { itemId: item2, userUuid: owner } }), c3);
    check('familiares claim -> 201 (limit 15)', c3._status === 201, c3._json);

    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  } finally {
    // --- Cleanup (idempotent) ---
    if (item2) await pool.query('DELETE FROM items WHERE id = $1', [item2]).catch(() => {});
    if (item1) await pool.query('DELETE FROM items WHERE id = $1', [item1]).catch(() => {});
    if (eventId) await pool.query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => {});
    if (pricedItemId) await pool.query('DELETE FROM items WHERE id = $1', [pricedItemId]).catch(() => {});
    await pool
      .query('DELETE FROM users WHERE uuid = ANY($1)', [[owner, pubUuid, famUuid]])
      .catch(() => {});
    await pool
      .query('DELETE FROM audit_log WHERE created_at >= $1 AND action LIKE \'%ITEM%\'', [t0])
      .catch(() => {});
    await pool.end();
  }
}

main()
  .then(() => {
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('Plan5 test crashed:', err);
    process.exit(1);
  });
