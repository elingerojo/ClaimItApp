/**
 * scripts/test-plan3.ts
 *
 * Functional test for Plan 3 (events management API + share links + effective
 * availability in the feed). Runs against the configured Neon DB using real
 * controller handlers (invoked directly with minimal req/res mocks) and the
 * RAM store. All created fixtures are cleaned up at the end.
 *
 * Run: npx tsx scripts/test-plan3.ts
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import pool from '../backend/src/config/db.js';
import {
  createEvent,
  updateEvent,
  getEventDetail,
  deleteEvent,
  validateInvitation,
  getShareLink
} from '../backend/src/controllers/eventsController.js';
import { createItem, updateItem } from '../backend/src/controllers/itemsController.js';
import { getInventoryFeed } from '../backend/src/controllers/feedsController.js';
import {
  getEvent,
  getItems,
  getEventMembership,
  upsertUser,
  upsertEventMember
} from '../backend/src/cache/appStore.js';

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
  const owner = crypto.randomUUID();
  const pubUuid = crypto.randomUUID();
  let eventId: string | null = null;
  let itemId: string | null = null;

  try {
    // --- Fixtures: temp users (owner=familiares, publico) ---
    await pool.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
      owner,
      `plan3_owner_${stamp}`,
      'familiares'
    ]);
    await pool.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [
      pubUuid,
      `plan3_pub_${stamp}`,
      'publico'
    ]);
    upsertUser({ uuid: owner, alias: `plan3_owner_${stamp}`, global_role: 'familiares' });
    upsertUser({ uuid: pubUuid, alias: `plan3_pub_${stamp}`, global_role: 'publico' });

    // --- Temp item created through the real handler (write-through to store) ---
    const itemRes = mockRes();
    await createItem(
      mockReq({
        body: {
          title: `TEST-PLAN3-ITEM-${stamp}`,
          description: 'temporary plan3 test item body',
          category: 'Misc.',
          infoUrl: null,
          imageUrls: ['https://example.com/x.jpg']
        }
      }),
      itemRes
    );
    check('createItem -> 201', itemRes._status === 201, itemRes._json);
    itemId = itemRes._json?.item?.id;
    check('item in store', getItems().some(i => i.id === itemId));

    // --- 1. createEvent persists advance/share bonus + generates 4 codes ---
    console.log('Test 1: createEvent');
    const availableFrom = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const pickupDeadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const createRes = mockRes();
    await createEvent(
      mockReq({
        body: {
          title: `Plan3 Event ${stamp}`,
          description: 'temporary event',
          available_from: availableFrom,
          pickup_deadline: pickupDeadline,
          familiares_advance_hours: 48,
          amigos_advance_hours: 12,
          amigos_share_bonus: 10
        },
        adminCode: 'test'
      }),
      createRes
    );
    check('createEvent -> 201', createRes._status === 201, createRes._json);
    eventId = createRes._json?.event?.eventId;
    check('event id returned', !!eventId);
    check(
      '4 invitation codes',
      Object.keys(createRes._json?.invitationCodes ?? {}).length === 4,
      createRes._json?.invitationCodes
    );

    const evRow = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
    check('familiares_advance_hours persisted (48)', evRow.rows[0]?.familiares_advance_hours === 48);
    check('amigos_advance_hours persisted (12)', evRow.rows[0]?.amigos_advance_hours === 12);
    check('amigos_share_bonus persisted (10)', evRow.rows[0]?.amigos_share_bonus === 10);
    check('event in store', !!getEvent(eventId!));
    check('no owner membership (admin event)', getEventMembership(owner, eventId!) === undefined);

    // Los eventos son del admin (sin dueño). Registramos un invitado "familiares"
    // (como entraría por un link real) para ejercitar feed/share por rol.
    await pool.query(
      `INSERT INTO event_members (event_id, user_uuid, role, invited_by, joined_at)
       VALUES ($1, $2, 'familiares', NULL, NOW())`,
      [eventId, owner]
    );
    upsertEventMember(owner, { eventId: eventId!, role: 'familiares', bonusHours: 0, invitedBy: null });
    check('familiares guest membership', getEventMembership(owner, eventId!)?.role === 'familiares');

    // --- 2. Assign the item to the event via the individual item PATCH
    // (the per-item strategy that replaces the removed bulk assignItems). ---
    console.log('Test 2: updateItem assigns event individually');
    const assignRes = mockRes();
    await updateItem(mockReq({ params: { id: itemId }, body: { event_id: eventId } }), assignRes);
    check('updateItem -> 200', assignRes._status === 200, assignRes._json);
    const itemRow = await pool.query('SELECT event_id FROM items WHERE id = $1', [itemId]);
    check('item.event_id set in DB', itemRow.rows[0]?.event_id === eventId);
    check('item.eventId set in store', getItems().find(i => i.id === itemId)?.eventId === eventId);

    // --- 3. Feed: effectiveAvailableFrom + canClaim (RAM, no Neon on read) ---
    console.log('Test 3: feed availability');
    const feedRes = mockRes();
    await getInventoryFeed(mockReq({ query: { userUuid: owner } }), feedRes);
    const ownerItem = (feedRes._json as any[]).find(i => i.id === itemId);
    check('owner sees the item (familiares, visibility 4)', !!ownerItem);
    check('owner item has eventId', ownerItem?.eventId === eventId);
    check('owner effectiveAvailableFrom present', !!ownerItem?.effectiveAvailableFrom);
    // effective = available_from - 48h (familiares) -> in the past -> canClaim true
    check('owner canClaim true (48h advance)', ownerItem?.canClaim === true, ownerItem);

    const pubRes = mockRes();
    await getInventoryFeed(mockReq({ query: { userUuid: pubUuid } }), pubRes);
    const pubItem = (pubRes._json as any[]).find(i => i.id === itemId);
    check('publico sees the item', !!pubItem);
    check('publico canClaim false (no advance, still future)', pubItem?.canClaim === false, pubItem);

    // --- 4. updateEvent propagates date change to inheriting items ---
    console.log('Test 4: updateEvent propagation');
    const newAvailable = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    const updRes = mockRes();
    await updateEvent(mockReq({ params: { id: eventId }, body: { available_from: newAvailable } }), updRes);
    check('updateEvent -> 200', updRes._status === 200, updRes._json);
    const propRow = await pool.query('SELECT available_from FROM items WHERE id = $1', [itemId]);
    check('item.available_from propagated (inherited)', !!propRow.rows[0]?.available_from, propRow.rows[0]);

    // --- 5. getEventDetail ---
    console.log('Test 5: getEventDetail');
    const detRes = mockRes();
    await getEventDetail(mockReq({ params: { id: eventId } }), detRes);
    check('detail -> 200', detRes._status === 200, detRes._json);
    check('detail has 1 item', detRes._json?.items?.length === 1);
    check(
      'detail has familiares member',
      detRes._json?.members?.some((m: any) => m.role === 'familiares')
    );
    check('detail has 4 invitations', detRes._json?.invitations?.length === 4);

    // --- 6. validateInvitation ---
    console.log('Test 6: validateInvitation');
    const amigosCode = createRes._json.invitationCodes.amigos;
    const valRes = mockRes();
    await validateInvitation(mockReq({ params: { id: eventId, code: amigosCode } }), valRes);
    check(
      'validate -> 200 with role amigos',
      valRes._status === 200 && valRes._json?.role === 'amigos',
      valRes._json
    );

    // --- 7. getShareLink ---
    console.log('Test 7: getShareLink');
    const shareOwner = mockRes();
    await getShareLink(mockReq({ query: { userUuid: owner }, params: { id: eventId } }), shareOwner);
    check(
      'owner (familiares) share link -> amigos role',
      shareOwner._status === 200 && shareOwner._json?.role === 'amigos',
      shareOwner._json
    );

    const sharePub = mockRes();
    await getShareLink(mockReq({ query: { userUuid: pubUuid }, params: { id: eventId } }), sharePub);
    check('publico share link -> 403', sharePub._status === 403, sharePub._json);

    // --- 8. deleteEvent detaches items ---
    console.log('Test 8: deleteEvent');
    const delRes = mockRes();
    await deleteEvent(mockReq({ params: { id: eventId } }), delRes);
    check('deleteEvent -> 200', delRes._status === 200, delRes._json);
    const afterDel = await pool.query('SELECT event_id FROM items WHERE id = $1', [itemId]);
    check('item.event_id NULL after delete', afterDel.rows[0]?.event_id === null);
    check('event removed from store', !getEvent(eventId!));
    check('item detached in store', getItems().find(i => i.id === itemId)?.eventId === null);

    console.log(`\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    // --- Cleanup (idempotent) ---
    if (eventId) {
      await pool.query('DELETE FROM events WHERE id = $1', [eventId]).catch(() => {});
    }
    if (itemId) await pool.query('DELETE FROM items WHERE id = $1', [itemId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE uuid = ANY($1)', [[owner, pubUuid]]).catch(() => {});
    await pool
      .query(
        `DELETE FROM audit_log WHERE created_at >= $1
         AND (action LIKE 'EVENT%' OR action = 'INVITATION_ACCEPTED'
              OR action IN ('ITEM_CREATED', 'ITEM_UPDATED'))`,
        [t0]
      )
      .catch(() => {});
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Plan3 test crashed:', err);
  process.exit(1);
});
