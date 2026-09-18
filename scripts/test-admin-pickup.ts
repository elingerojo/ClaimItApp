/**
 * scripts/test-admin-pickup.ts
 *
 * Verifica la recepción / entrega por usuario (pantalla "Registrar entrega"):
 *
 *  Parte A (SIEMPRE, sin BD): helper puro `pickableItemsForUser` —
 *   1. claim_open: el titular de mayor prioridad es el claim activo con menor
 *      `claimed_at` (fifo_position NULL para todos). Los demás NO son recogibles.
 *   2. claim_open con el #1 cancelado: el #2 pasa a ser prioridad máxima.
 *   3. pickup_turns tras expirio del #1: el #2 es el titular activo.
 *   4. ventana_libre: cualquier claim activo del usuario es recogible.
 *   5. Fases terminales (entregado / enviado_a_caridad) nunca son recogibles.
 *
 *  Parte B (solo con `--db`, toca la BD de backend/.env):
 *   1. Fuerza de entrega en claim_open (antes de T_inicio): el ADMIN entrega al
 *      #1 ⇒ phase='entregado', delivered_claim_id/delivered_at, los demás activos
 *      quedan 'void'.
 *   2. Guarda de prioridad: entregar a un usuario que NO es el #1 ⇒ 'not_priority'.
 *   3. `freezeItemIfDue` no re-congela un item ya entregado.
 *   4. pickup_turns tras expirio: se entrega al titular activo (posición siguiente).
 *   Limpia fixtures (cascade borra claims/items) al final.
 *
 * Uso:
 *   npx tsx scripts/test-admin-pickup.ts          (solo Parte A)
 *   npx tsx scripts/test-admin-pickup.ts --db     (Parte A + B contra la BD)
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../backend/src/config/db.js';
import type { StoreClaim, StoreItem } from '../backend/src/cache/appStore.js';
import {
  deliverItemByAdmin,
  freezeItemIfDue,
  pickableItemsForUser
} from '../backend/src/services/queueService.js';

dotenv.config({ path: path.resolve('backend/.env') });

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

// ---------------------------------------------------------------------------
// Fixtures en memoria (Parte A)
// ---------------------------------------------------------------------------
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function claim(over: Partial<StoreClaim> & Pick<StoreClaim, 'id' | 'userUuid'>): StoreClaim {
  return {
    itemId: 'item-1',
    username: over.userUuid,
    claimedAt: at(0),
    claimState: 'active',
    roleAtClaim: 'publico',
    fifoPosition: null,
    turnVExpiresAt: null,
    claimantEmail: null,
    claimantPhone: null,
    ...over
  };
}

function item(over: Partial<StoreItem> & Pick<StoreItem, 'id' | 'phase'>): StoreItem {
  return {
    eventId: 'event-1',
    title: `Item ${over.id}`,
    description: null,
    category: 'Misc.',
    infoUrl: null,
    imageUrls: ['https://example.com/p.jpg'],
    status: 'waitlist_open',
    visibilityLevel: 4,
    precioBaseCosto: null,
    barcode: null,
    barcodeType: null,
    marketCurrency: null,
    marketMinPrice: null,
    marketMaxPrice: null,
    marketAvgPrice: null,
    marketOffersCount: null,
    marketAnalyzedAt: null,
    frozenSchedule: null,
    frozenAt: null,
    freeWindowOpenedAt: null,
    deliveredClaimId: null,
    deliveredAt: null,
    charityAt: null,
    createdAt: at(0),
    queue: [],
    ...over
  };
}

// ---------------------------------------------------------------------------
// Parte A — helper puro (sin BD)
// ---------------------------------------------------------------------------
function testPurePriority(): void {
  console.log('Parte A: pickableItemsForUser (prioridad FIFO, sin BD)');

  // --- A.1 claim_open: prioridad por claimed_at ---
  const openItem = item({
    id: 'open-1',
    phase: 'claim_open',
    queue: [
      claim({ id: 'c2', userUuid: 'u2', claimedAt: at(2) }),
      claim({ id: 'c1', userUuid: 'u1', claimedAt: at(1) }),
      claim({ id: 'c3', userUuid: 'u3', claimedAt: at(3) })
    ]
  });
  const picksA = pickableItemsForUser([openItem], 'u1');
  check('A.1 #1 (menor claimed_at) es recogible', picksA.length === 1 && picksA[0].claimId === 'c1', picksA);
  check('A.1 reason=open_claim_first', picksA[0]?.reason === 'open_claim_first', picksA[0]);
  check(
    'A.1 prioridad #1 de 3, holdersAhead 0',
    picksA[0]?.priorityPosition === 1 && picksA[0]?.holderCount === 3 && picksA[0]?.holdersAhead === 0,
    picksA[0]
  );
  check('A.1 #2 NO es recogible', pickableItemsForUser([openItem], 'u2').length === 0);
  check('A.1 #3 NO es recogible', pickableItemsForUser([openItem], 'u3').length === 0);
  check('A.1 usuario ajeno NO es recogible', pickableItemsForUser([openItem], 'ux').length === 0);

  // --- A.2 claim_open: #1 cancelado ⇒ #2 hereda prioridad ---
  const openAfterCancel = item({
    id: 'open-2',
    phase: 'claim_open',
    queue: [
      claim({ id: 'c1', userUuid: 'u1', claimedAt: at(1), claimState: 'cancelado_voluntario' }),
      claim({ id: 'c2', userUuid: 'u2', claimedAt: at(2) }),
      claim({ id: 'c3', userUuid: 'u3', claimedAt: at(3) })
    ]
  });
  const picksB = pickableItemsForUser([openAfterCancel], 'u2');
  check('A.2 el #2 activo es ahora recogible', picksB.length === 1 && picksB[0].claimId === 'c2', picksB);
  check('A.2 #1 cancelado NO es recogible', pickableItemsForUser([openAfterCancel], 'u1').length === 0);

  // --- A.3 pickup_turns: #1 expirado ⇒ #2 titular activo ---
  const turnsItem = item({
    id: 'turns-1',
    phase: 'pickup_turns',
    queue: [
      claim({ id: 'c1', userUuid: 'u1', claimedAt: at(1), claimState: 'expirado', fifoPosition: 1 }),
      claim({ id: 'c2', userUuid: 'u2', claimedAt: at(2), fifoPosition: 2, turnVExpiresAt: at(120) }),
      claim({ id: 'c3', userUuid: 'u3', claimedAt: at(3), fifoPosition: 3, turnVExpiresAt: at(180) })
    ]
  });
  const picksC = pickableItemsForUser([turnsItem], 'u2');
  check('A.3 el #2 (turno activo) es recogible', picksC.length === 1 && picksC[0].claimId === 'c2', picksC);
  check('A.3 reason=turn_holder', picksC[0]?.reason === 'turn_holder', picksC[0]);
  check('A.3 expone turnVExpiresAt', pickableItemsForUser([turnsItem], 'u2')[0]?.turnVExpiresAt === at(120));
  check('A.3 el #3 NO es recogible aún', pickableItemsForUser([turnsItem], 'u3').length === 0);

  // --- A.4 ventana_libre: cualquier claim activo ---
  const freeItem = item({
    id: 'free-1',
    phase: 'ventana_libre',
    queue: [claim({ id: 'c1', userUuid: 'u1', claimedAt: at(1) })]
  });
  const picksD = pickableItemsForUser([freeItem], 'u1');
  check('A.4 claim activo en ventana_libre es recogible', picksD.length === 1 && picksD[0].reason === 'free_window_claim', picksD);
  check('A.4 sin claim no es recogible', pickableItemsForUser([freeItem], 'u2').length === 0);

  // --- A.5 fases terminales ---
  for (const phase of ['entregado', 'enviado_a_caridad'] as const) {
    const closed = item({
      id: `closed-${phase}`,
      phase,
      queue: [claim({ id: 'c1', userUuid: 'u1' })]
    });
    check(`A.5 ${phase} NO es recogible`, pickableItemsForUser([closed], 'u1').length === 0);
  }

  // --- A.6 claim_open sin activos ---
  const emptyOpen = item({ id: 'open-3', phase: 'claim_open', queue: [] });
  check('A.6 claim_open sin activos no lista a nadie', pickableItemsForUser([emptyOpen], 'u1').length === 0);
}

// ---------------------------------------------------------------------------
// Parte B — integración con la BD (solo con --db)
// ---------------------------------------------------------------------------
async function createEvent(withFutureClose: boolean): Promise<string> {
  const res = await pool.query(
    `INSERT INTO events (title, published_at, available_from, claims_close_at, pickup_deadline, status)
     VALUES ($1, NOW() - interval '2 days', NOW() - interval '2 days',
             $2, $3, 'active')
     RETURNING id`,
    [
      `pickup_test_${crypto.randomUUID().slice(0, 8)}`,
      withFutureClose ? null : new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    ]
  );
  return res.rows[0].id as string;
}

async function createFutureCloseEvent(): Promise<string> {
  const res = await pool.query(
    `INSERT INTO events (title, published_at, available_from, claims_close_at, pickup_deadline, status)
     VALUES ($1, NOW() - interval '2 days', NOW() - interval '2 days',
             NOW() + interval '2 days', NOW() + interval '4 days', 'active')
     RETURNING id`,
    [`pickup_open_${crypto.randomUUID().slice(0, 8)}`]
  );
  return res.rows[0].id as string;
}

async function createItem(eventId: string, title: string): Promise<string> {
  const res = await pool.query(
    `INSERT INTO items (event_id, title, category, image_urls, visibility_level)
     VALUES ($1, $2, 'Misc.', '["https://example.com/p.jpg"]'::jsonb, 4)
     RETURNING id`,
    [eventId, title]
  );
  return res.rows[0].id as string;
}

async function createUser(role = 'publico'): Promise<{ uuid: string; alias: string }> {
  const uuid = crypto.randomUUID();
  const alias = `pickup_${uuid.slice(0, 8)}`;
  await pool.query(`INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)`, [
    uuid,
    alias,
    role
  ]);
  return { uuid, alias };
}

async function testDatabase(): Promise<void> {
  console.log('\nParte B: integración con BD (--db)');

  const users = [await createUser(), await createUser(), await createUser()];
  const eventOpen = await createFutureCloseEvent(); // item queda claim_open
  const eventTurns = await createEvent(false); // claims_close_at pasado ⇒ congela
  const itemOpen = await createItem(eventOpen, `pickup_open_item_${Date.now()}`);
  const itemTurns = await createItem(eventTurns, `pickup_turns_item_${Date.now()}`);

  try {
    // 3 claims activos con claimed_at escalonado: users[0] el MÁS antiguo ⇒ #1
    // de la FIFO (la prioridad es el menor claimed_at).
    for (let i = 0; i < users.length; i++) {
      await pool.query(
        `INSERT INTO claims (item_id, user_uuid, claim_state, role_at_claim, claimed_at)
         VALUES ($1, $2, 'active', 'publico', NOW() - ($3 || ' minutes')::interval)`,
        [itemOpen, users[i].uuid, String(users.length - i)]
      );
    }

    // --- B.1/B.2 guarda de prioridad ---
    const wrong = await deliverItemByAdmin({ itemId: itemOpen, expectedUserUuid: users[1].uuid });
    check(
      'B.2 entregar a quien NO es #1 ⇒ not_priority',
      wrong.ok === false && wrong.code === 'not_priority',
      wrong
    );

    // --- B.1 fuerza de entrega en claim_open ---
    const ok = await deliverItemByAdmin({ itemId: itemOpen, expectedUserUuid: users[0].uuid });
    check('B.1 entrega al #1 en claim_open ⇒ ok', ok.ok === true, ok);
    if (ok.ok) {
      check('B.1 earlyPickup=true', ok.earlyPickup === true, ok);
      check('B.1 deliveredClaimId = claim del #1', !!ok.deliveredClaimId);
      check('B.1 2 claims anulados (void)', ok.voided.length === 2, ok.voided);
    }

    const itemRow = (
      await pool.query(`SELECT phase, delivered_at, delivered_claim_id FROM items WHERE id = $1`, [
        itemOpen
      ])
    ).rows[0];
    check('B.1 items.phase=entregado', itemRow.phase === 'entregado', itemRow);
    check('B.1 delivered_at seteado', !!itemRow.delivered_at, itemRow);

    const claimStates = (
      await pool.query(
        `SELECT claim_state, COUNT(*)::int AS n FROM claims WHERE item_id = $1 GROUP BY claim_state`,
        [itemOpen]
      )
    ).rows;
    const activeLeft = Number(claimStates.find((r: any) => r.claim_state === 'active')?.n ?? 0);
    const voided = Number(claimStates.find((r: any) => r.claim_state === 'void')?.n ?? 0);
    check('B.1 queda 1 activo (el entregado)', activeLeft === 1, claimStates);
    check('B.1 quedan 2 void', voided === 2, claimStates);

    // --- B.3 no re-congela un item entregado ---
    const freeze = await freezeItemIfDue(itemOpen);
    check(
      'B.3 freezeItemIfDue no re-congela un entregado',
      freeze.frozen === false && freeze.phase === 'entregado',
      freeze
    );

    // --- B.4 pickup_turns tras expirio del #1 ---
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `INSERT INTO claims (item_id, user_uuid, claim_state, role_at_claim, claimed_at)
         VALUES ($1, $2, 'active', 'publico', NOW() - ($3 || ' minutes')::interval)`,
        [itemTurns, users[i].uuid, String(2 - i)]
      );
    }
    const frozen = await freezeItemIfDue(itemTurns);
    check('B.4 el item congela a pickup_turns', frozen.frozen === true && frozen.phase === 'pickup_turns', frozen);

    // Expira el #1 (posición 1) ⇒ el #2 pasa a ser titular activo.
    await pool.query(
      `UPDATE claims SET claim_state = 'expirado', updated_at = NOW()
       WHERE item_id = $1 AND fifo_position = 1`,
      [itemTurns]
    );

    const toExpired = await deliverItemByAdmin({ itemId: itemTurns, expectedUserUuid: users[0].uuid });
    check(
      'B.4 el #1 expirado ya no es recogible ⇒ not_priority',
      toExpired.ok === false && toExpired.code === 'not_priority',
      toExpired
    );

    const toNext = await deliverItemByAdmin({ itemId: itemTurns, expectedUserUuid: users[1].uuid });
    check('B.4 se entrega al titular activo siguiente', toNext.ok === true, toNext);
    if (toNext.ok) {
      check('B.4 earlyPickup=false (ya congelado)', toNext.earlyPickup === false, toNext);
    }
  } finally {
    // Cascade: borrar items borra claims; luego eventos y usuarios.
    await pool.query(`DELETE FROM items WHERE event_id = ANY($1)`, [[eventOpen, eventTurns]]);
    await pool.query(`DELETE FROM events WHERE id = ANY($1)`, [[eventOpen, eventTurns]]);
    await pool.query(`DELETE FROM users WHERE uuid = ANY($1)`, [users.map((u) => u.uuid)]);
  }
}

async function main(): Promise<void> {
  testPurePriority();

  if (process.argv.includes('--db')) {
    try {
      await testDatabase();
    } catch (err) {
      failures++;
      console.error('Parte B falló:', err);
    }
  } else {
    console.log('\n(Parte B omitida: agrega --db para correr la integración contra backend/.env)');
  }

  // Cierra el pool (aunque la Parte B no haya corrido) para que el proceso salga.
  await pool.end().catch(() => {});

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} fallo(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
