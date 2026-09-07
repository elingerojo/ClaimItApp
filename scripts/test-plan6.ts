/**
 * scripts/test-plan6.ts
 *
 * Functional test for Plan 6 (expiration tolerance + sanctions + El Brinco):
 *  1. publico (non-member) -> blacklisted on first expiration; createClaim -> 403.
 *  2. conocidos at threshold -> permanent degradation to publico.
 *  3. amigos at threshold -> loses invite rights; getShareLink -> 403.
 *  4. familiares -> infinite tolerance (no sanction).
 *  5. Completing a purchase on time reduces the counter and lifts the block.
 *  6. Cascade ("El Brinco"): familiares share -> amigos code; amigos -> conocidos.
 * Runs against Neon with temp fixtures, cleaned up at the end.
 *
 * Run: npx tsx scripts/test-plan6.ts
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../backend/src/config/db.js';
import {
  applyExpirationSanction,
  reduceExpirationCount
} from '../backend/src/services/trustSanctions.js';
import { createClaim } from '../backend/src/controllers/claimsController.js';
import { getShareLink } from '../backend/src/controllers/eventsController.js';
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
  const owner = crypto.randomUUID();
  const pubUuid = crypto.randomUUID();
  const conoUuid = crypto.randomUUID();
  const amigUuid = crypto.randomUUID();
  const famUuid = crypto.randomUUID();
  let eventId: string | null = null;
  let itemId: string | null = null;

  const client = await pool.connect();
  try {
    // --- Fixtures ---
    await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1,$2,$3)', [owner, `p6_owner_${stamp}`, 'familiares']);
    await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1,$2,$3)', [pubUuid, `p6_pub_${stamp}`, 'publico']);
    await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1,$2,$3)', [conoUuid, `p6_cono_${stamp}`, 'conocidos']);
    await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1,$2,$3)', [amigUuid, `p6_amig_${stamp}`, 'amigos']);
    await client.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1,$2,$3)', [famUuid, `p6_fam_${stamp}`, 'familiares']);

    const ev = await client.query(
      `INSERT INTO events (title, available_from, pickup_deadline)
       VALUES ($1, NOW() + interval '1 hour', NOW() + interval '3 days') RETURNING id`,
      [`Plan6 Event ${stamp}`]
    );
    eventId = ev.rows[0].id;

    // 4 códigos de invitación (como hace createEvent) para el flujo de cascada
    for (const role of ['familiares', 'amigos', 'conocidos', 'publico']) {
      const code = crypto.randomBytes(8).toString('hex');
      await client.query(
        `INSERT INTO event_invitations (event_id, role, code, created_by)
         VALUES ($1, $2, $3, NULL)`,
        [eventId, role, code]
      );
    }

    // Miembros con contadores pre-cargados (umbral-1)
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, invited_by, expiraciones_acumuladas)
       VALUES ($1, $2, 'conocidos', $2, 1)`, [eventId, conoUuid]);
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, invited_by, expiraciones_acumuladas)
       VALUES ($1, $2, 'amigos', $2, 2)`, [eventId, amigUuid]);
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, invited_by, expiraciones_acumuladas)
       VALUES ($1, $2, 'familiares', $2, 5)`, [eventId, famUuid]);

    const it = await client.query(
      `INSERT INTO items (title, description, category, image_urls, status, event_id)
       VALUES ($1, $2, 'Misc.', '[]'::jsonb, 'available', $3) RETURNING id`,
      [`TEST-PLAN6-${stamp}`, 'temp plan6 item', eventId]
    );
    itemId = it.rows[0].id;

    upsertUser({ uuid: pubUuid, alias: `p6_pub_${stamp}`, global_role: 'publico' });
    upsertUser({ uuid: amigUuid, alias: `p6_amig_${stamp}`, global_role: 'amigos' });

    // --- 1. publico (non-member): blacklist on first expiration ---
    console.log('Test 1: publico blacklist');
    const s1 = await applyExpirationSanction(eventId!, pubUuid, client);
    check('publico sanctioned blacklisted', s1?.sanctioned === 'blacklisted', s1);
    const pubRow = await pool.query('SELECT bloqueado_apartar FROM users WHERE uuid = $1', [pubUuid]);
    check('users.bloqueado_apartar = true', pubRow.rows[0]?.bloqueado_apartar === true);

    const claimRes = mockRes();
    await createClaim(mockReq({ body: { itemId, userUuid: pubUuid } }), claimRes);
    check('createClaim for blacklisted -> 403', claimRes._status === 403, claimRes._json);

    // --- 2. conocidos: degradation ---
    console.log('Test 2: conocidos degradation');
    const s2 = await applyExpirationSanction(eventId!, conoUuid, client);
    check('conocidos sanctioned degraded', s2?.sanctioned === 'degraded', s2);
    const conoEm = await pool.query('SELECT role FROM event_members WHERE event_id = $1 AND user_uuid = $2', [eventId, conoUuid]);
    const conoU = await pool.query('SELECT global_role FROM users WHERE uuid = $1', [conoUuid]);
    check('event_members.role -> publico', conoEm.rows[0]?.role === 'publico');
    check('users.global_role -> publico', conoU.rows[0]?.global_role === 'publico');

    // --- 3. amigos: lose invite rights ---
    console.log('Test 3: amigos invite block');
    const s3 = await applyExpirationSanction(eventId!, amigUuid, client);
    check('amigos sanctioned invite_blocked', s3?.sanctioned === 'invite_blocked', s3);
    const amigEm = await pool.query('SELECT bloqueado_invitar FROM event_members WHERE event_id = $1 AND user_uuid = $2', [eventId, amigUuid]);
    check('event_members.bloqueado_invitar = true', amigEm.rows[0]?.bloqueado_invitar === true);

    const shareRes = mockRes();
    await getShareLink(mockReq({ query: { userUuid: amigUuid }, params: { id: eventId } }), shareRes);
    check('getShareLink for blocked amigos -> 403', shareRes._status === 403, shareRes._json);

    // --- 4. familiares: infinite tolerance ---
    console.log('Test 4: familiares infinite tolerance');
    const s4 = await applyExpirationSanction(eventId!, famUuid, client);
    check('familiares no sanction', s4?.sanctioned === 'none', s4);
    const famEm = await pool.query('SELECT role, bloqueado_invitar FROM event_members WHERE event_id = $1 AND user_uuid = $2', [eventId, famUuid]);
    check('familiares still familiares + not blocked', famEm.rows[0]?.role === 'familiares' && famEm.rows[0]?.bloqueado_invitar === false);

    // --- 5. pickup on time reduces counter + unblocks ---
    console.log('Test 5: reduceExpirationCount');
    await reduceExpirationCount(eventId!, amigUuid, client);
    const amigAfter = await pool.query(
      'SELECT expiraciones_acumuladas, bloqueado_invitar FROM event_members WHERE event_id = $1 AND user_uuid = $2',
      [eventId, amigUuid]
    );
    check('counter reduced to 2', amigAfter.rows[0]?.expiraciones_acumuladas === 2, amigAfter.rows[0]);
    check('invite block lifted', amigAfter.rows[0]?.bloqueado_invitar === false);

    // --- 6. El Brinco (cascade share-link): familiares -> amigos, amigos -> conocidos ---
    console.log('Test 6: El Brinco cascade');
    upsertUser({ uuid: famUuid, alias: `p6_fam_${stamp}`, global_role: 'familiares' });
    const shareFam = mockRes();
    await getShareLink(mockReq({ query: { userUuid: famUuid }, params: { id: eventId } }), shareFam);
    check('familiares share -> amigos role', shareFam._status === 200 && shareFam._json?.role === 'amigos', shareFam._json);
    const shareAmig = mockRes();
    await getShareLink(mockReq({ query: { userUuid: amigUuid }, params: { id: eventId } }), shareAmig);
    check('amigos share -> conocidos role', shareAmig._status === 200 && shareAmig._json?.role === 'conocidos', shareAmig._json);
    const sharePub = mockRes();
    await getShareLink(mockReq({ query: { userUuid: pubUuid }, params: { id: eventId } }), sharePub);
    check('publico cannot share -> 403', sharePub._status === 403, sharePub._json);

    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  } finally {
    if (itemId) await pool.query('DELETE FROM items WHERE id = $1', [itemId]).catch(() => {});
    if (eventId) await pool.query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => {});
    await pool
      .query('DELETE FROM users WHERE uuid = ANY($1)', [[owner, pubUuid, conoUuid, amigUuid, famUuid]])
      .catch(() => {});
    client.release();
    await pool.end();
  }
}

main()
  .then(() => {
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('Plan6 test crashed:', err);
    process.exit(1);
  });
