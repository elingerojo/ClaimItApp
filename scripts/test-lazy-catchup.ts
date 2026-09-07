/**
 * scripts/test-lazy-catchup.ts
 *
 * Verifies the lazy expiration (catch-up on activity) that replaces the
 * always-on scheduler polling:
 *  1. hasOverdueDeadlinesInStore() detects overdue deadlines in RAM (no Neon).
 *  2. runLazyCatchUp() evicts an overdue claim on Neon and advances the queue.
 *  3. After catch-up the store is clean and a second call is a no-op (returns 0).
 * Cleans up temp fixtures. Windows-safe exit.
 *
 * Run: npx tsx scripts/test-lazy-catchup.ts
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../backend/src/config/db.js';
import { upsertItem, getItems } from '../backend/src/cache/appStore.js';
import {
  hasOverdueDeadlinesInStore,
  runLazyCatchUp
} from '../backend/src/services/scheduler.js';

dotenv.config({ path: path.resolve('backend/.env') });

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const uuid = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const pastDeadline = new Date(Date.now() - 60 * 1000).toISOString();
  const futureDeadline = new Date(Date.now() + 3600 * 1000).toISOString();

  try {
    // --- Fixtures en Neon ---
    await pool.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
      uuid,
      `lazy_${stamp}`,
      'publico'
    ]);
    const it = await pool.query(
      `INSERT INTO items (title, description, category, image_urls, status)
       VALUES ($1, $2, 'Misc.', '[]'::jsonb, 'waitlist_open') RETURNING id`,
      [`TEST-LAZY-${stamp}`, 'temp lazy item']
    );
    const dbItemId = it.rows[0].id;
    await pool.query(
      `INSERT INTO claims (item_id, user_uuid, username, pickup_deadline)
       VALUES ($1, $2, 'lazy', $3)`,
      [dbItemId, uuid, pastDeadline]
    );

    // --- Seed store con deadline vencido ---
    upsertItem({
      id: dbItemId,
      title: `TEST-LAZY-${stamp}`,
      description: null,
      category: 'Misc.',
      infoUrl: null,
      imageUrls: [],
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
      queue: [{ userUuid: uuid, username: 'lazy', claimedAt: new Date().toISOString(), pickupDeadline: pastDeadline }]
    });

    // --- 1. detección en RAM (sin Neon) ---
    console.log('Test 1: hasOverdueDeadlinesInStore');
    check('detects overdue deadline in store', hasOverdueDeadlinesInStore() === true);

    // --- 2. catch-up evicta el claim vencido ---
    console.log('Test 2: runLazyCatchUp eviction');
    const evicted = await runLazyCatchUp();
    check('evicted 1 claim', evicted === 1, evicted);

    const claimRow = await pool.query('SELECT COUNT(*)::int AS n FROM claims WHERE item_id = $1', [dbItemId]);
    check('claim removed from Neon', claimRow.rows[0].n === 0);

    const statusRow = await pool.query('SELECT status FROM items WHERE id = $1', [dbItemId]);
    check('item status -> available', statusRow.rows[0].status === 'available');

    const storeItem = getItems().find(i => i.id === dbItemId);
    check('store queue empty after catch-up', storeItem?.queue.length === 0, storeItem);

    // --- 3. store limpio -> no-op ---
    console.log('Test 3: clean store no-op');
    check('no overdue after catch-up', hasOverdueDeadlinesInStore() === false);
    const second = await runLazyCatchUp();
    check('second call returns 0 (no Neon work)', second === 0, second);

    // --- 4. deadline futuro no dispara catch-up ---
    console.log('Test 4: future deadline ignored');
    upsertItem({ ...getItems().find(i => i.id === dbItemId)!, queue: [{ userUuid: uuid, username: 'lazy2', claimedAt: new Date().toISOString(), pickupDeadline: futureDeadline }] });
    check('future deadline NOT overdue', hasOverdueDeadlinesInStore() === false);
    const third = await runLazyCatchUp();
    check('third call returns 0 (future)', third === 0, third);

    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  } finally {
    await pool.query('DELETE FROM items WHERE id = $1', [itemId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE uuid = $1', [uuid]).catch(() => {});
    await pool.end();
  }
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error('Lazy catch-up test crashed:', err);
    process.exit(1);
  });
