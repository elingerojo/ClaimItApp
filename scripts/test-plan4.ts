/**
 * scripts/test-plan4.ts
 *
 * Verifies the Plan 4 backend support used by the UI:
 *  1. POST /api/session returns globalRole (needs a running server on :3000).
 *  2. GET /api/items?userUuid returns myPickupDeadline for the user's claim
 *     (tested at handler level with a seeded RAM store, so no server needed).
 * Cleans up temp fixtures and closes the pool before exiting (Windows-safe).
 *
 * Run: npx tsx scripts/test-plan4.ts  (server optional for part 1)
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import pool from '../backend/src/config/db.js';
import { upsertItem } from '../backend/src/cache/appStore.js';
import { getInventoryFeed } from '../backend/src/controllers/feedsController.js';

dotenv.config({ path: path.resolve('backend/.env') });

const API = 'http://localhost:3000/api';
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
  const uuid = crypto.randomUUID();
  const alias = `plan4_${stamp}`;
  const itemId = crypto.randomUUID();
  const deadline = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  try {
    // --- 1. /api/session returns globalRole ---
    console.log('Test 1: session globalRole (API)');
    try {
      const sesRes = await fetch(`${API}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, alias, isFromSession: false })
      });
      const ses = await sesRes.json();
      check('session -> 201', sesRes.status === 201, ses);
      check('globalRole present (publico)', ses.globalRole === 'publico', ses);
    } catch {
      check('server reachable', false, 'server not running on :3000');
    }

    // --- 2. Feed myPickupDeadline (handler + seeded store) ---
    console.log('Test 2: feed myPickupDeadline (handler level)');
    upsertItem({
      id: itemId,
      title: `TEST-PLAN4-${stamp}`,
      description: null,
      category: 'Misc.',
      infoUrl: null,
      imageUrls: ['https://example.com/x.jpg'],
      status: 'waitlist_open',
      visibilityLevel: 4,
      eventId: null,
      visibleAt: null,
      availableFrom: null,
      expiresAt: null,
      precioBaseCosto: null,
      precioFamiliar: null,
      precioAmigo: null,
      precioConocido: null,
      precioPublico: null,
      horasRecoleccionFamiliar: null,
      horasRecoleccionAmigo: null,
      horasRecoleccionConocido: null,
      horasRecoleccionPublico: null,
      nivelAccesoMinimo: null,
      createdAt: new Date().toISOString(),
      queue: [
        { userUuid: uuid, username: alias, claimedAt: new Date().toISOString(), pickupDeadline: deadline }
      ]
    });

    const res = mockRes();
    await getInventoryFeed(mockReq({ query: { userUuid: uuid } }), res);
    const myItem = (res._json as any[]).find(i => i.id === itemId);
    check('item visible in feed', !!myItem);
    check('myPickupDeadline returned', myItem?.myPickupDeadline === deadline, myItem);
    check('canClaim true (no scheduling)', myItem?.canClaim === true, myItem);

    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  } finally {
    // Cleanup temp user (part 1 may have created it)
    await pool.query('DELETE FROM users WHERE uuid = $1', [uuid]).catch(() => {});
    await pool.end();
  }
}

main()
  .then(() => {
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error('Plan4 test crashed:', err);
    process.exitCode = 1;
  });
