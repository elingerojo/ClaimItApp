/**
 * scripts/test-v2-strategy.ts — VERIFICACIÓN END-TO-END de la Estrategia temporal v2
 *
 * Fase 5 (verificación E2E del motor + cierre de docs/limpieza legacy). Contrato:
 *   plans/estrategia-temporal-v2.md (§4 reglas deterministas).
 *
 * Dos bloques:
 *   A) UNIT (motor puro de shared, SIN DB): aserciones de porciones/calendario
 *      vía computeVmin / computeTurnSlices / buildPickupSchedule / buildFrozenSchedule:
 *        - cola mixta [amigos,publico,conocidos]: shares 20% / 9% (0.6·Vmin, Vmin=15%)
 *          / 15%, ventana 56%; V1..V3 dentro del contenedor y charity_at = pickup_deadline.
 *        - cola solo públicos: 9% cada uno, ventana 73%.
 *        - cola vacía: ventana libre 100% desde T_inicio (v1..v3 null).
 *        - lista incompleta (2 ocupados): ventana libre desde el V del último ocupado.
 *   B) INTEGRACIÓN (contra la BD, transacciones reales de queueService + limpieza):
 *      crea eventos de prueba con contenedor relativo a NOW y items/usuarios por rol
 *      deterministas; ejecuta secuencialmente el flujo del motor (freeze, dominó por
 *      cancelación voluntaria SIN sanción y con V fijo heredado, expirio con sanción
 *      por rol, captura en ventana libre, entrega por admin en pickup_turns y en
 *      ventana libre walk-in, caridad al alcanzar T_final) y borra TODOS los fixtures
 *      al final (sin dejar filas huérfanas).
 *
 * NOTA de runner: reutiliza el mismo mecanismo que los scripts .ts del repo
 * (npx tsx scripts/*.ts). El congelamiento se invoca vía freezeItemIfDue (motor
 * transaccional contra la BD); runLazyCatchUp/scheduler solo operan sobre el store
 * RAM rehidratado y no aplican a este script DB-only. El .env se carga desde la raíz
 * por backend/src/config/db.ts (dotenv sin path).
 *
 * Run (desde la raíz del repo):
 *   npm run build -w shared   # o npm --prefix shared run build (dist de @claimitapp/shared)
 *   npx tsx scripts/test-v2-strategy.ts
 */
import crypto from 'node:crypto';
import {
  buildFrozenSchedule,
  buildPickupSchedule,
  computeTurnSlices,
  computeVmin,
  shareForRole,
  PICKUP_PCT,
  PUBLICO_FACTOR,
  V_MIN_FALLBACK,
  MAX_QUEUE_POSITIONS,
  type FrozenSchedule,
  type ItemPhase,
  type Role
} from '@claimitapp/shared';
import pool from '../backend/src/config/db.js';
import {
  freezeItemIfDue,
  applyDueTransitions,
  claimItem,
  voluntarilyLeaveItem,
  deliverItemByAdmin
} from '../backend/src/services/queueService.js';

// ---------------------------------------------------------------------------
// Helpers de aserción
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, extra?: unknown): void {
  checks++;
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

const ms = (iso: string): number => new Date(iso).getTime();
const isoOf = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v);
const closeTo = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol;

/** Aproximación a 4 decimales para fracciones de porción. */
function approxShare(expected: number, actual: number, tol = 0.000001): boolean {
  return Math.abs(expected - actual) <= tol;
}

// ---------------------------------------------------------------------------
// A) UNIT — motor puro de shared (sin DB)
// ---------------------------------------------------------------------------
function runUnit(): void {
  section('A. UNIT — motor puro de shared (porciones / calendario v2)');

  // Times fijos con C_total = 1 día (86_400_000 ms).
  const t0 = '2026-09-08T00:00:00.000Z';
  const t1 = '2026-09-09T00:00:00.000Z';
  const C = ms(t1) - ms(t0); // 86_400_000

  // --- A.1 Cola mixta [amigos, publico, conocidos] ---
  {
    const roles: (Role | null)[] = ['amigos', 'publico', 'conocidos'];
    const vmin = computeVmin(roles);
    check('A1 vmin = 15% (conocidos presente)', approxShare(vmin, 0.15), vmin);
    const slices = computeTurnSlices(roles);
    check(
      'A1 shares = [0.20, 0.09 (0.6·Vmin), 0.15]',
      approxShare(slices[0].share, PICKUP_PCT.amigos) &&
        approxShare(slices[1].share, PUBLICO_FACTOR * vmin) &&
        approxShare(slices[2].share, PICKUP_PCT.conocidos),
      slices.map((s) => s.share)
    );
    check(
      'A1 roles por posición = [amigos, publico, conocidos]',
      slices[0].role === 'amigos' && slices[1].role === 'publico' && slices[2].role === 'conocidos'
    );

    const sched = buildPickupSchedule({ claimsCloseAt: t0, pickupDeadline: t1, queueRoles: roles });
    check('A1 ventana = 100% − 44% = 56%', approxShare(0.56, 1 - (0.2 + 0.09 + 0.15)));
    check('A1 V1 = T0 + 0.20·C', closeTo(ms(sched.v1!) - ms(t0), 0.2 * C), sched.v1);
    check('A1 V2 = T0 + 0.29·C', closeTo(ms(sched.v2!) - ms(t0), 0.29 * C), sched.v2);
    check('A1 V3 = T0 + 0.44·C', closeTo(ms(sched.v3!) - ms(t0), 0.44 * C), sched.v3);
    check('A1 V1 < V2 < V3 < T_final', ms(sched.v1!) < ms(sched.v2!) && ms(sched.v2!) < ms(sched.v3!) && ms(sched.v3!) < ms(t1));
    check('A1 ventana libre empieza en V3', sched.freeWindowStart === sched.v3, sched.freeWindowStart);
    check('A1 charity_at === pickup_deadline (T_final)', sched.charityAt === t1, sched.charityAt);
    check('A1 c_total_seconds = 86400', sched.cTotalSeconds === 86400, sched.cTotalSeconds);
    check('A1 posiciones vacías con share 0 no existen (3 ocupadas)', sched.slices.length === 3);
  }

  // --- A.2 Cola solo públicos [publico, publico, publico] ---
  {
    const roles: (Role | null)[] = ['publico', 'publico', 'publico'];
    const vmin = computeVmin(roles);
    check('A2 vmin fallback = 15% (solo público)', approxShare(vmin, V_MIN_FALLBACK), vmin);
    const slices = computeTurnSlices(roles);
    const pubShare = PUBLICO_FACTOR * V_MIN_FALLBACK; // 0.09
    check(
      'A2 shares = [0.09, 0.09, 0.09] (9% c/u)',
      slices.every((s) => approxShare(s.share, pubShare)),
      slices.map((s) => s.share)
    );
    check('A2 ventana libre = 73%', approxShare(1 - 3 * pubShare, 0.73));
    const sched = buildPickupSchedule({ claimsCloseAt: t0, pickupDeadline: t1, queueRoles: roles });
    check('A2 V1 = T0 + 0.09·C', closeTo(ms(sched.v1!) - ms(t0), 0.09 * C), sched.v1);
    check('A2 V2 = T0 + 0.18·C', closeTo(ms(sched.v2!) - ms(t0), 0.18 * C), sched.v2);
    check('A2 V3 = T0 + 0.27·C', closeTo(ms(sched.v3!) - ms(t0), 0.27 * C), sched.v3);
    check('A2 ventana libre empieza en V3', sched.freeWindowStart === sched.v3);
  }

  // --- A.3 Cola vacía (100% ventana libre desde T_inicio) ---
  {
    const roles: (Role | null)[] = [];
    const vmin = computeVmin(roles);
    check('A3 vmin fallback = 15% (cola vacía)', approxShare(vmin, V_MIN_FALLBACK), vmin);
    const slices = computeTurnSlices(roles);
    check('A3 shares = [0, 0, 0]', slices.every((s) => s.share === 0), slices.map((s) => s.share));
    const sched = buildPickupSchedule({ claimsCloseAt: t0, pickupDeadline: t1, queueRoles: roles });
    check('A3 v1/v2/v3 = null (sin posiciones)', sched.v1 === null && sched.v2 === null && sched.v3 === null);
    check('A3 ventana libre empieza en T_inicio (100% libre)', sched.freeWindowStart === t0, sched.freeWindowStart);
    check('A3 charity_at === pickup_deadline', sched.charityAt === t1);
  }

  // --- A.4 Lista incompleta (2 ocupados: [amigos, publico]) ---
  {
    const roles: (Role | null)[] = ['amigos', 'publico'];
    const vmin = computeVmin(roles);
    check('A4 vmin = 20% (amigos presente, público no suma)', approxShare(vmin, PICKUP_PCT.amigos), vmin);
    const slices = computeTurnSlices(roles);
    check(
      'A4 shares = [0.20, 0.12 (0.6·Vmin=0.6·0.2), 0]',
      approxShare(slices[0].share, 0.2) &&
        approxShare(slices[1].share, PUBLICO_FACTOR * PICKUP_PCT.amigos) &&
        slices[2].share === 0,
      slices.map((s) => s.share)
    );
    const sched = buildPickupSchedule({ claimsCloseAt: t0, pickupDeadline: t1, queueRoles: roles });
    check('A4 V1 = T0 + 0.20·C', closeTo(ms(sched.v1!) - ms(t0), 0.2 * C));
    check('A4 V2 = T0 + 0.32·C (último ocupado)', closeTo(ms(sched.v2!) - ms(t0), 0.32 * C));
    check('A4 v3 = null (posición 3 vacía)', sched.v3 === null);
    check('A4 ventana libre empieza en V2 (V del último ocupado)', sched.freeWindowStart === sched.v2, sched.freeWindowStart);
    check('A4 ventana ≠ V3 (no hay pos 3)', sched.freeWindowStart !== sched.v3);
  }

  // --- A.5 buildFrozenSchedule: snapshot idempotente (mixto) ---
  {
    const frozen = buildFrozenSchedule({
      frozenAt: t0,
      claimsCloseAt: t0,
      pickupDeadline: t1,
      queue: [
        { role: 'amigos', claimId: 'c-1' },
        { role: 'publico', claimId: 'c-2' },
        { role: 'conocidos', claimId: 'c-3' }
      ]
    });
    check('A5 version = 2', frozen.version === 2);
    check('A5 t_inicio/t_final mapean T0/T1', frozen.t_inicio === t0 && frozen.t_final === t1);
    check('A5 vmin_pct = 15', frozen.vmin_pct === 15, frozen.vmin_pct);
    check('A5 charity_at === t_final', frozen.charity_at === t1, frozen.charity_at);
    check('A5 ventana_libre_starts_at === v3', frozen.ventana_libre_starts_at === frozen.v3);
    check('A5 positions = 3 ocupadas', frozen.positions.length === 3);
    const byPos = [...frozen.positions].sort((a, b) => a.position - b.position);
    check(
      'A5 share_pct por posición = [20, 9, 15]',
      byPos[0].share_pct === 20 && byPos[1].share_pct === 9 && byPos[2].share_pct === 15,
      frozen.positions
    );
    check(
      'A5 roles por posición = [amigos, publico, conocidos]',
      byPos[0].role === 'amigos' && byPos[1].role === 'publico' && byPos[2].role === 'conocidos'
    );
    check(
      'A5 v_expires_at por posición = V1/V2/V3',
      byPos[0].v_expires_at === frozen.v1 &&
        byPos[1].v_expires_at === frozen.v2 &&
        byPos[2].v_expires_at === frozen.v3
    );
    check(
      'A5 claim_id forense preservado',
      byPos[0].claim_id === 'c-1' && byPos[1].claim_id === 'c-2' && byPos[2].claim_id === 'c-3'
    );
    // V1..V3 respetan T_final: v3 < t_final y charity_at === t_final.
    check('A5 V1<V2<V3<T_final y charity_at===T_final', ms(frozen.v1!) < ms(frozen.v2!) && ms(frozen.v2!) < ms(frozen.v3!) && ms(frozen.v3!) < ms(frozen.t_final) && frozen.charity_at === frozen.t_final);
    check('A5 MAX_QUEUE_POSITIONS = 3', MAX_QUEUE_POSITIONS === 3);
    check('A5 shareForRole(vacía) = 0', shareForRole(null, 0.15) === 0);
  }
}

// ---------------------------------------------------------------------------
// B) INTEGRACIÓN — contra la BD (eventos/items/usuarios de prueba, limpieza total)
// ---------------------------------------------------------------------------
interface TestUser {
  uuid: string;
  role: Role;
  alias: string;
}
interface TestEvent {
  id: string;
  closeIso: string;
  pickupIso: string;
}

async function runIntegration(): Promise<void> {
  section('B. INTEGRACIÓN — motor transaccional contra la BD (con limpieza)');

  const now = Date.now();
  const H = 60 * 60 * 1000;
  const stamp = Date.now();
  const iso = (msVal: number): string => new Date(msVal).toISOString();
  let userSeq = 0;
  // alias único (users.alias tiene índice UNIQUE lower): incluye key + secuencia.
  const makeUser = (role: Role, key: string): TestUser => {
    userSeq++;
    return { uuid: crypto.randomUUID(), role, alias: `v2-${key}-${userSeq}-${stamp}` };
  };

  const users: Record<string, TestUser> = {
    uAmigo: makeUser('amigos', 'uAmigo'),
    uPub1: makeUser('publico', 'uPub1'),
    uCono: makeUser('conocidos', 'uCono'),
    uPub2: makeUser('publico', 'uPub2'),
    uAmigoB: makeUser('amigos', 'uAmigoB'),
    uFam: makeUser('familiares', 'uFam'),
    uAmigoC: makeUser('amigos', 'uAmigoC'),
    uWalkin: makeUser('publico', 'uWalkin'),
    uPubD: makeUser('publico', 'uPubD')
  };
  const userUuids = Object.values(users).map((u) => u.uuid);

  // Events de prueba (contenedor relativo a NOW):
  //   E1  contenedor activo en curso:  T_inicio = NOW−2h, T_final = NOW+12h.
  //   E2  expirios por reloj:          T_inicio = NOW−10h, T_final = NOW+1h (turnos ya vencidos).
  //   E3  caridad (T_final pasado):    T_inicio = NOW−24h, T_final = NOW−2h.
  const events: Record<string, TestEvent> = {} as Record<string, TestEvent>;
  const mkEvent = async (
    key: string,
    title: string,
    publishedOffsetH: number,
    availableOffsetH: number,
    closeOffsetH: number,
    pickupOffsetH: number,
    status: string
  ): Promise<TestEvent> => {
    const res = await pool.query(
      `INSERT INTO events (title, published_at, available_from, claims_close_at, pickup_deadline, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        title,
        iso(now + publishedOffsetH * H),
        iso(now + availableOffsetH * H),
        iso(now + closeOffsetH * H),
        iso(now + pickupOffsetH * H),
        status
      ]
    );
    const e = { id: res.rows[0].id as string, closeIso: iso(now + closeOffsetH * H), pickupIso: iso(now + pickupOffsetH * H) };
    events[key] = e;
    return e;
  };

  await mkEvent('E1', `TEST-V2-E1-${stamp}`, -30, -24, -2, 12, 'closing');
  await mkEvent('E2', `TEST-V2-E2-${stamp}`, -34, -30, -10, 1, 'closing');
  await mkEvent('E3', `TEST-V2-E3-${stamp}`, -48, -46, -24, -2, 'closed');

  const eventIds = Object.values(events).map((e) => e.id);

  // Fixtures.
  try {
    // Usuarios.
    for (const u of Object.values(users)) {
      await pool.query('INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)', [u.uuid, u.alias, u.role]);
    }

    // Membresías (contadores de sanción/recompensa deterministas).
    const member = async (eventKey: string, userKey: string, expiraciones = 0): Promise<void> => {
      await pool.query(
        `INSERT INTO event_members (event_id, user_uuid, expiraciones_acumuladas) VALUES ($1, $2, $3)`,
        [events[eventKey].id, users[userKey].uuid, expiraciones]
      );
    };
    await member('E1', 'uAmigo');
    await member('E1', 'uPub1');
    await member('E1', 'uCono');
    await member('E1', 'uFam', 1); // para probar la recompensa (reduce) al entregar
    await member('E1', 'uAmigoC');
    await member('E1', 'uWalkin');
    await member('E2', 'uPub2'); // público: umbral 1 → blacklist en el primer expirio
    await member('E2', 'uAmigoB', 2); // amigos: umbral 3 → invite-blocked al tercer expirio
    await member('E3', 'uPubD');

    const mkItem = async (eventKey: string, title: string): Promise<string> => {
      const res = await pool.query(
        `INSERT INTO items (event_id, title, description, category, image_urls, status, phase)
         VALUES ($1, $2, NULL, 'Misc.', '[]'::jsonb, 'available', 'claim_open')
         RETURNING id`,
        [events[eventKey].id, title]
      );
      return res.rows[0].id as string;
    };

    const mkClaim = async (
      itemId: string,
      userKey: string,
      claimedAt: string
    ): Promise<string> => {
      const res = await pool.query(
        `INSERT INTO claims (item_id, user_uuid, claim_state, role_at_claim, claimed_at)
         VALUES ($1, $2, 'active', $3, $4)
         RETURNING id`,
        [itemId, users[userKey].uuid, users[userKey].role, claimedAt]
      );
      return res.rows[0].id as string;
    };

    const getItem = async (itemId: string): Promise<any> => {
      const res = await pool.query(
        `SELECT phase, status, frozen_schedule, frozen_at, free_window_opened_at,
                delivered_claim_id, delivered_at, charity_at
         FROM items WHERE id = $1`,
        [itemId]
      );
      return res.rows[0];
    };
    const getClaims = async (itemId: string): Promise<any[]> => {
      const res = await pool.query(
        `SELECT id, user_uuid, claim_state, role_at_claim, fifo_position, turn_v_expires_at, claimed_at
         FROM claims WHERE item_id = $1
         ORDER BY fifo_position ASC NULLS LAST, claimed_at ASC, id ASC`,
        [itemId]
      );
      return res.rows;
    };
    const getUser = async (uuid: string): Promise<any> => {
      const res = await pool.query('SELECT global_role, bloqueado_apartar FROM users WHERE uuid = $1', [uuid]);
      return res.rows[0];
    };
    const getMember = async (eventId: string, uuid: string): Promise<any> => {
      const res = await pool.query(
        `SELECT expiraciones_acumuladas, bloqueado_invitar FROM event_members WHERE event_id = $1 AND user_uuid = $2`,
        [eventId, uuid]
      );
      return res.rows[0];
    };

    // =============================================================
    // B.1 FREEZE en T_inicio — cola mixta [amigos, publico, conocidos]
    // =============================================================
    console.log('\n-- B.1 Congelamiento en T_inicio (freezeItemIfDue) --');
    const itemMix = await mkItem('E1', `TEST-V2-MIX-${stamp}`);
    // claimed_at estrictamente anterior a T_inicio (NOW−2h) y en orden FIFO.
    await mkClaim(itemMix, 'uAmigo', iso(now - 3 * H));
    await mkClaim(itemMix, 'uPub1', iso(now - 2 * H - 45 * 60 * 1000));
    await mkClaim(itemMix, 'uCono', iso(now - 2 * H - 20 * 60 * 1000));

    const fr = await freezeItemIfDue(itemMix);
    check('B1 freeze ok (frozen=true, phase=pickup_turns)', fr.frozen === true && fr.phase === 'pickup_turns', fr);
    check('B1 queueCount = 3', fr.queueCount === 3, fr.queueCount);

    const mixRow = await getItem(itemMix);
    const fs: FrozenSchedule = mixRow.frozen_schedule;
    check('B1 items.phase = pickup_turns', mixRow.phase === 'pickup_turns', mixRow.phase);
    check('B1 frozen_schedule presente (snapshot idempotente)', !!fs && fs.version === 2, fs);
    check('B1 frozen_schedule.t_inicio === E1.claims_close_at', fs.t_inicio === events.E1.closeIso, { fs: fs.t_inicio, exp: events.E1.closeIso });
    check('B1 frozen_schedule.t_final === E1.pickup_deadline', fs.t_final === events.E1.pickupIso, { fs: fs.t_final, exp: events.E1.pickupIso });
    check('B1 charity_at === pickup_deadline', fs.charity_at === events.E1.pickupIso, fs.charity_at);
    check('B1 vmin_pct = 15', fs.vmin_pct === 15, fs.vmin_pct);

    const byPos = (f: FrozenSchedule) => [...f.positions].sort((a, b) => a.position - b.position);
    const mixPos = byPos(fs);
    check(
      'B1 V1..V3 en snapshot: shares 20/9/15',
      mixPos.length === 3 && mixPos[0].share_pct === 20 && mixPos[1].share_pct === 9 && mixPos[2].share_pct === 15,
      fs.positions
    );
    check(
      'B1 roles por posición = [amigos, publico, conocidos]',
      mixPos[0].role === 'amigos' && mixPos[1].role === 'publico' && mixPos[2].role === 'conocidos',
      fs.positions
    );
    check(
      'B1 V1 < V2 < V3 < T_final (respectan T_final)',
      !!(fs.v1 && fs.v2 && fs.v3) &&
        ms(fs.v1!) < ms(fs.v2!) &&
        ms(fs.v2!) < ms(fs.v3!) &&
        ms(fs.v3!) < ms(fs.t_final)
    );
    check('B1 ventana libre inicia en V3', fs.ventana_libre_starts_at === fs.v3, fs.ventana_libre_starts_at);

    const mixClaims = await getClaims(itemMix);
    check('B1 3 claims activos con fifo_position asignada', mixClaims.length === 3 && mixClaims.every((c) => c.fifo_position !== null && c.claim_state === 'active'));
    const expectedV: Record<number, string | null> = { 1: fs.v1, 2: fs.v2, 3: fs.v3 };
    check(
      'B1 turn_v_expires_at de cada claim === su V fijo del snapshot',
      mixClaims.every((c) => isoOf(c.turn_v_expires_at) === expectedV[Number(c.fifo_position)]),
      mixClaims.map((c) => ({ pos: c.fifo_position, v: isoOf(c.turn_v_expires_at) }))
    );
    // Orden FIFO por claimed_at → uAmigo pos1, uPub1 pos2, uCono pos3.
    const posOfUser = (key: string): number => mixClaims.find((c) => c.user_uuid === users[key].uuid)?.fifo_position;
    check('B1 uAmigo=pos1, uPub1=pos2, uCono=pos3', posOfUser('uAmigo') === 1 && posOfUser('uPub1') === 2 && posOfUser('uCono') === 3, mixClaims.map((c) => ({ u: c.user_uuid, p: c.fifo_position })));

    // Idempotencia: segundo freeze no re-congela.
    const fr2 = await freezeItemIfDue(itemMix);
    check('B1 freeze idempotente (segundo llamado = frozen:false)', fr2.frozen === false, fr2);

    // =============================================================
    // B.2 Dominó por CANCELACIÓN voluntaria del titular activo (neutral, V fijo)
    // =============================================================
    console.log('\n-- B.2 Cancelación voluntaria del titular (dominó neutral) --');
    const leaveBefore = await getMember(events.E1.id, users.uAmigo.uuid);
    const leave = await voluntarilyLeaveItem(itemMix, users.uAmigo.uuid);
    const leaveOk = leave.ok === true ? leave : null;
    check('B2 leave ok + fue titular activo', leaveOk !== null && leaveOk.wasActiveHolder === true, leave);
    check('B2 phase sigue pickup_turns (quedan 2 activos)', leaveOk?.phase === 'pickup_turns', leave);
    const afterLeaveClaims = await getClaims(itemMix);
    const amigoClaim = afterLeaveClaims.find((c) => c.user_uuid === users.uAmigo.uuid);
    const pub1Claim = afterLeaveClaims.find((c) => c.user_uuid === users.uPub1.uuid);
    const conoClaim = afterLeaveClaims.find((c) => c.user_uuid === users.uCono.uuid);
    check('B2 uAmigo → cancelado_voluntario (sin sanción)', amigoClaim?.claim_state === 'cancelado_voluntario', amigoClaim);
    check('B2 siguiente (uPub1) sigue activo y conserva fifo_position=2', pub1Claim?.claim_state === 'active' && pub1Claim?.fifo_position === 2, pub1Claim);
    check('B2 turn_v_expires_at de uPub1 NO cambia (heredó V2 fijo)', isoOf(pub1Claim?.turn_v_expires_at) === fs.v2, { got: isoOf(pub1Claim?.turn_v_expires_at), exp: fs.v2 });
    check('B2 uCono (pos3) sigue activo con V3', conoClaim?.claim_state === 'active' && isoOf(conoClaim?.turn_v_expires_at) === fs.v3, conoClaim);
    const leaveAfter = await getMember(events.E1.id, users.uAmigo.uuid);
    check('B2 expiraciones_acumuladas de uAmigo intactas (cancelación ≠ expirio)', leaveAfter.expiraciones_acumuladas === leaveBefore.expiraciones_acumuladas, leaveAfter);
    check('B2 uAmigo no bloqueado_apartar (sin sanción)', (await getUser(users.uAmigo.uuid)).bloqueado_apartar === false);

    // Último activo que cancela → ventana libre en este instante.
    const itemLast = await mkItem('E1', `TEST-V2-LAST-${stamp}`);
    await mkClaim(itemLast, 'uCono', iso(now - 3 * H));
    await freezeItemIfDue(itemLast);
    const leaveLast = await voluntarilyLeaveItem(itemLast, users.uCono.uuid);
    const leaveLastOk = leaveLast.ok === true ? leaveLast : null;
    check('B2 último activo cancela → ventana_libre + free_window_opened_at', leaveLastOk !== null && leaveLastOk.phase === 'ventana_libre' && !!leaveLastOk.freeWindowOpenedAt, leaveLast);
    const lastRow = await getItem(itemLast);
    check('B2 item quedó ventana_libre en DB', lastRow.phase === 'ventana_libre' && !!lastRow.free_window_opened_at, lastRow.phase);
    check('B2 uCono sin sanción en E1 (contador intacto)', (await getMember(events.E1.id, users.uCono.uuid)).expiraciones_acumuladas === 0);

    // =============================================================
    // B.3 EXPIRIO por reloj — sanción por rol global (contador/bloqueo) + avance
    // =============================================================
    console.log('\n-- B.3 Expirio de turnos (applyDueTransitions + sanción) --');
    const itemExp = await mkItem('E2', `TEST-V2-EXP-${stamp}`);
    await mkClaim(itemExp, 'uPub2', iso(now - 11 * H)); // T_inicio = NOW−10h → claimed antes
    await mkClaim(itemExp, 'uAmigoB', iso(now - 10 * H - 30 * 60 * 1000));
    const frExp = await freezeItemIfDue(itemExp);
    check('B3 freeze expirio → pickup_turns', frExp.frozen === true && frExp.phase === 'pickup_turns', frExp);
    const expClaimsFrozen = await getClaims(itemExp);
    const expFrozen = (await getItem(itemExp)).frozen_schedule as FrozenSchedule;
    check(
      'B3 V1/V2 asignados y ya vencidos (<= NOW)',
      expClaimsFrozen.every((c) => c.turn_v_expires_at !== null && new Date(c.turn_v_expires_at).getTime() <= Date.now()),
      expClaimsFrozen.map((c) => ({ pos: c.fifo_position, v: isoOf(c.turn_v_expires_at) }))
    );
    check('B3 snapshot mixto público+amigos (Vmin=20%, público 12%)', expFrozen.vmin_pct === 20 && (expFrozen.positions.find((p) => p.role === 'publico')?.share_pct ?? 0) === 12, expFrozen.positions);

    const tr = await applyDueTransitions(itemExp);
    check('B3 expiraron 2 turnos', tr.expired.length === 2, tr);
    check('B3 ambos claims → expirado', (await getClaims(itemExp)).every((c) => c.claim_state === 'expirado'));
    const expItemRow = await getItem(itemExp);
    check('B3 al agotarse posiciones → ventana_libre + free_window_opened_at', tr.phase === 'ventana_libre' && !!tr.freeWindowOpenedAt, tr);
    check('B3 item en DB = ventana_libre', expItemRow.phase === 'ventana_libre', expItemRow.phase);

    // uPub2 (publico): primer expirio → blacklist global + contador 1.
    const pub2User = await getUser(users.uPub2.uuid);
    const pub2Member = await getMember(events.E2.id, users.uPub2.uuid);
    check('B3 uPub2 expiraciones_acumuladas = 1', pub2Member.expiraciones_acumuladas === 1, pub2Member);
    check('B3 uPub2 bloqueado_apartar = true (blacklist público)', pub2User.bloqueado_apartar === true, pub2User);

    // uAmigoB (amigos): tercer expirio (2 previos + 1) → invite-blocked (sin degradar rol).
    const amigoBUser = await getUser(users.uAmigoB.uuid);
    const amigoBMember = await getMember(events.E2.id, users.uAmigoB.uuid);
    check('B3 uAmigoB expiraciones_acumuladas = 3', amigoBMember.expiraciones_acumuladas === 3, amigoBMember);
    check('B3 uAmigoB bloqueado_invitar = true (amigos umbral 3)', amigoBMember.bloqueado_invitar === true, amigoBMember);
    check('B3 uAmigoB conserva global_role=amigos (no degrada)', amigoBUser.global_role === 'amigos', amigoBUser);

    // =============================================================
    // B.4 VENTANA LIBRE — captura directa por un usuario (claimItem)
    // =============================================================
    console.log('\n-- B.4 Ventana libre: captura directa (claimItem) --');
    const itemCap = await mkItem('E1', `TEST-V2-CAP-${stamp}`); // sin claims → freeze abre ventana en T_inicio
    const frCap = await freezeItemIfDue(itemCap);
    check('B4 cola vacía → ventana_libre desde T_inicio', frCap.frozen === true && frCap.phase === 'ventana_libre', frCap);
    const capRow0 = await getItem(itemCap);
    const capFs0: FrozenSchedule = capRow0.frozen_schedule;
    check('B4 free_window_opened_at === E1.claims_close_at', isoOf(capRow0.free_window_opened_at) === events.E1.closeIso, capRow0.free_window_opened_at);
    check('B4 snapshot cola vacía: v1/v2/v3 null y ventana desde T_inicio', capFs0.v1 === null && capFs0.v2 === null && capFs0.v3 === null && capFs0.ventana_libre_starts_at === events.E1.closeIso, capFs0);

    const cap = await claimItem({
      itemId: itemCap,
      userUuid: users.uWalkin.uuid,
      username: users.uWalkin.alias,
      role: 'publico'
    });
    const capOk = cap.ok === true ? cap : null;
    check('B4 captura directa ok (free_window_capture)', capOk !== null && capOk.kind === 'free_window_capture', cap);
    const capRow = await getItem(itemCap);
    check('B4 item → entregado con delivered_claim_id', capRow.phase === 'entregado' && !!capRow.delivered_claim_id && isoOf(capRow.delivered_at) !== null, capRow);
    check('B4 delivered_claim_id === claim del capturador', capOk !== null && capRow.delivered_claim_id === capOk.claimId, capRow.delivered_claim_id);
    // Workflows detenidos: nueva transición sobre entregado = no-op.
    const trStop = await applyDueTransitions(itemCap);
    check('B4 workflows detenidos (applyDueTransitions = no-op)', trStop.changed === false && (await getItem(itemCap)).phase === 'entregado', trStop);

    // =============================================================
    // B.5 ENTREGA POR ADMIN — pickup_turns (titular) y ventana_libre (walk-in)
    // =============================================================
    console.log('\n-- B.5 Entrega por ADMIN (deliverItemByAdmin) --');
    const itemAdmin = await mkItem('E1', `TEST-V2-ADMIN-${stamp}`);
    const famClaimId = await mkClaim(itemAdmin, 'uFam', iso(now - 3 * H));
    const amigoCClaimId = await mkClaim(itemAdmin, 'uAmigoC', iso(now - 2 * H - 30 * 60 * 1000));
    const frAdm = await freezeItemIfDue(itemAdmin);
    check('B5 freeze admin → pickup_turns', frAdm.frozen === true && frAdm.phase === 'pickup_turns', frAdm);

    const famMemberBefore = await getMember(events.E1.id, users.uFam.uuid);
    check('B5 setup: uFam con 1 expiración (para probar recompensa)', famMemberBefore.expiraciones_acumuladas === 1, famMemberBefore);

    const deliver = await deliverItemByAdmin({ itemId: itemAdmin });
    const deliverOk = deliver.ok === true ? deliver : null;
    check('B5 entrega ok (pickup_turns → entregado)', deliverOk !== null && deliverOk.phase === 'entregado', deliver);
    const admRow = await getItem(itemAdmin);
    check('B5 delivered_claim_id === claim del titular (uFam)', admRow.delivered_claim_id === famClaimId, admRow.delivered_claim_id);
    check('B5 delivered_at presente', !!admRow.delivered_at);
    const admClaims = await getClaims(itemAdmin);
    const famC = admClaims.find((c) => c.id === famClaimId);
    const amigoCC = admClaims.find((c) => c.id === amigoCClaimId);
    check('B5 titular conserva claim activo (forense)', famC?.claim_state === 'active', famC);
    check('B5 resto de activos → void forense (sin sanción)', amigoCC?.claim_state === 'void', amigoCC);
    const famMemberAfter = await getMember(events.E1.id, users.uFam.uuid);
    check('B5 recompensa: entregar a tiempo reduce expiraciones 1→0', famMemberAfter.expiraciones_acumuladas === 0, famMemberAfter);

    // Ventana libre walk-in (sin claim): admin marca entregado sin delivered_claim_id.
    const itemWalkin = await mkItem('E1', `TEST-V2-WALK-${stamp}`);
    await freezeItemIfDue(itemWalkin); // cola vacía → ventana_libre
    const walkin = await deliverItemByAdmin({ itemId: itemWalkin });
    const walkinOk = walkin.ok === true ? walkin : null;
    check('B5 walk-in ok (ventana_libre → entregado)', walkinOk !== null && walkinOk.phase === 'entregado', walkin);
    const walkinRow = await getItem(itemWalkin);
    check('B5 walk-in: delivered_claim_id = null', walkinRow.delivered_claim_id === null, walkinRow);
    check('B5 walk-in: status legacy = unavailable', walkinRow.status === 'unavailable', walkinRow.status);

    // =============================================================
    // B.6 CARIDAD — T_final alcanzado sin entrega → enviado_a_caridad
    // =============================================================
    console.log('\n-- B.6 Caridad al alcanzar T_final (applyDueTransitions) --');
    const itemChar = await mkItem('E3', `TEST-V2-CHAR-${stamp}`);
    await mkClaim(itemChar, 'uPubD', iso(now - 25 * H)); // antes de T_inicio (NOW−24h)
    const frChar = await freezeItemIfDue(itemChar);
    check('B6 freeze caridad → pickup_turns (cola 1)', frChar.frozen === true && frChar.phase === 'pickup_turns', frChar);
    const charBefore = await getItem(itemChar);
    const charFs: FrozenSchedule = charBefore.frozen_schedule;
    check('B6 snapshot charity_at === T_final (pasado)', charFs.charity_at === events.E3.pickupIso, charFs.charity_at);

    const trChar = await applyDueTransitions(itemChar);
    check('B6 → enviado_a_caridad (charity_at fijado)', trChar.phase === 'enviado_a_caridad' && !!trChar.charityAt, trChar);
    check('B6 claims activos → void (cierre de interacción)', trChar.voidedCount === 1 && (await getClaims(itemChar)).every((c) => c.claim_state === 'void'), trChar);
    const charRow = await getItem(itemChar);
    check('B6 items.phase = enviado_a_caridad + status unavailable', charRow.phase === 'enviado_a_caridad' && charRow.status === 'unavailable', charRow);
    // No más transiciones sobre terminal.
    const trChar2 = await applyDueTransitions(itemChar);
    check('B6 caridad es terminal (no-op en transiciones)', trChar2.changed === false, trChar2);

    console.log('\n-- B.7 Limpieza de datos de prueba --');
    await pool.query('DELETE FROM items WHERE event_id = ANY($1::uuid[])', [eventIds]);
    await pool.query('DELETE FROM events WHERE id = ANY($1::uuid[])', [eventIds]);
    await pool.query('DELETE FROM users WHERE uuid = ANY($1::uuid[])', [userUuids]);

    const orphanItems = await pool.query('SELECT COUNT(*)::int AS n FROM items WHERE event_id = ANY($1::uuid[])', [eventIds]);
    const orphanEvents = await pool.query('SELECT COUNT(*)::int AS n FROM events WHERE id = ANY($1::uuid[])', [eventIds]);
    const orphanMembers = await pool.query('SELECT COUNT(*)::int AS n FROM event_members WHERE event_id = ANY($1::uuid[])', [eventIds]);
    const orphanClaims = await pool.query('SELECT COUNT(*)::int AS n FROM claims WHERE user_uuid = ANY($1::uuid[])', [userUuids]);
    const orphanUsers = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE uuid = ANY($1::uuid[])', [userUuids]);
    check('Limpieza: 0 items huérfanos', orphanItems.rows[0].n === 0, orphanItems.rows[0]);
    check('Limpieza: 0 eventos de prueba', orphanEvents.rows[0].n === 0, orphanEvents.rows[0]);
    check('Limpieza: 0 membresías huérfanas', orphanMembers.rows[0].n === 0, orphanMembers.rows[0]);
    check('Limpieza: 0 claims huérfanos', orphanClaims.rows[0].n === 0, orphanClaims.rows[0]);
    check('Limpieza: 0 usuarios de prueba', orphanUsers.rows[0].n === 0, orphanUsers.rows[0]);
  } finally {
    // Red de seguridad: si algo falló a mitad, borrar por marcador del título.
    await pool
      .query(`DELETE FROM items WHERE title LIKE 'TEST-V2-%' ESCAPE '' OR event_id = ANY($1::uuid[])`, [eventIds])
      .catch(() => {});
    await pool.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [eventIds]).catch(() => {});
    await pool.query(`DELETE FROM events WHERE title LIKE 'TEST-V2-E%' ESCAPE ''`, []).catch(() => {});
    await pool.query(`DELETE FROM users WHERE uuid = ANY($1::uuid[])`, [userUuids]).catch(() => {});
  }
}

async function main(): Promise<void> {
  console.log('scripts/test-v2-strategy.ts — Estrategia temporal v2 (Fase 5: verificación E2E)');
  runUnit();
  await runIntegration();
  console.log(
    `\nResult: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'} (${checks} aserciones en total)`
  );
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(async (err) => {
    console.error('test-v2-strategy crashed:', err);
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
