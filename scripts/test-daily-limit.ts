/**
 * scripts/test-daily-limit.ts
 *
 * Verifica el LÍMITE DIARIO de apartados por rol (migración 0008):
 *
 *  Parte A (SIEMPRE, sin BD): helpers puros compartidos `dailyWarningThreshold`
 *  y `dailyClaimStatus` — umbral = ceil(25% del límite); cap 5 avisa al 3º
 *  ("Te quedan 2/5"), silencio con 2 registrados, bloqueo al llegar al límite.
 *
 *  Parte B (solo con `--db`, toca la BD configurada en backend/.env):
 *   1. Enforcement: al agotar el cupo diario, `claimItem` devuelve
 *      `daily_limit_exceeded` (distinto de `limit_exceeded`).
 *   2. Liberación voluntaria ("Ya no lo quiero") DEVUELVE el cupo del día.
 *   3. Expirio / void NO devuelven cupo (siguen contando).
 *   4. La ventana libre NO está sujeta al límite diario.
 *   5. El corte del día es UTC-6: un claim de ayer no cuenta hoy.
 *   Restaura `max_apartados_diarios` del rol usado y limpia fixtures al final.
 *
 * Uso:
 *   npx tsx scripts/test-daily-limit.ts          (solo Parte A)
 *   npx tsx scripts/test-daily-limit.ts --db     (Parte A + B contra la BD)
 */
import crypto from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { dailyClaimStatus, dailyWarningThreshold } from '@claimitapp/shared';

dotenv.config({ path: path.resolve('backend/.env') });

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

const TEST_ROLE = 'familiares' as const;
const TEST_DAILY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Parte A — helpers puros (sin BD)
// ---------------------------------------------------------------------------
function testPureHelpers(): void {
  console.log('Parte A: helpers puros (sin BD)');

  check('dailyWarningThreshold(5) = 2 (ceil 25%)', dailyWarningThreshold(5) === 2, dailyWarningThreshold(5));
  check('dailyWarningThreshold(4) = 1', dailyWarningThreshold(4) === 1, dailyWarningThreshold(4));
  check('dailyWarningThreshold(8) = 2', dailyWarningThreshold(8) === 2, dailyWarningThreshold(8));
  check('dailyWarningThreshold(0) = 0', dailyWarningThreshold(0) === 0, dailyWarningThreshold(0));
  check('dailyWarningThreshold(1) = 1', dailyWarningThreshold(1) === 1, dailyWarningThreshold(1));

  const after2 = dailyClaimStatus(5, 2);
  check(
    'cap 5, usados 2 -> remaining 3, sin aviso',
    after2.remaining === 3 && after2.warn === false && after2.atLimit === false,
    after2
  );

  const after3 = dailyClaimStatus(5, 3);
  check(
    'cap 5, usados 3 -> remaining 2, aviso activo (Te quedan 2/5)',
    after3.remaining === 2 && after3.warn === true && after3.atLimit === false,
    after3
  );

  const after5 = dailyClaimStatus(5, 5);
  check(
    'cap 5, usados 5 -> remaining 0, atLimit (botón deshabilitado)',
    after5.remaining === 0 && after5.warn === false && after5.atLimit === true,
    after5
  );

  const zeroLimit = dailyClaimStatus(0, 0);
  check('cap 0 -> atLimit inmediato (rol bloqueado ese día)', zeroLimit.atLimit === true, zeroLimit);

  const overflow = dailyClaimStatus(5, 9);
  check('usados > límite -> remaining 0, atLimit', overflow.remaining === 0 && overflow.atLimit === true, overflow);
}

// ---------------------------------------------------------------------------
// Parte B — integración con BD (opt-in con --db)
// ---------------------------------------------------------------------------
async function testDatabase(): Promise<void> {
  const { default: pool } = await import('../backend/src/config/db.js');
  const { claimItem, voluntarilyLeaveItem } = await import('../backend/src/services/queueService.js');
  const { upsertUser } = await import('../backend/src/cache/appStore.js');

  const stamp = Date.now();
  const userUuid = crypto.randomUUID();
  const otherUuid = crypto.randomUUID();
  let eventId: string | null = null;
  let previousDailyLimit: number | null = null;

  const newItem = async (n: number, phase = 'claim_open'): Promise<string> => {
    const res = await pool.query(
      `INSERT INTO items (title, description, category, image_urls, status, phase, event_id)
       VALUES ($1, $2, 'Misc.', '[]'::jsonb, 'available', $3, $4) RETURNING id`,
      [`TEST-DAILY-${stamp}-${n}`, 'temp item límite diario', phase, eventId]
    );
    return res.rows[0].id;
  };

  try {
    // Fixtures: usuarios + evento publicado con FIFO abierta.
    await pool.query(
      `INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3), ($4, $5, 'publico')`,
      [userUuid, `daily_test_${stamp}`, TEST_ROLE, otherUuid, `daily_other_${stamp}`]
    );
    upsertUser({ uuid: userUuid, alias: `daily_test_${stamp}`, global_role: TEST_ROLE });

    const evRes = await pool.query(
      `INSERT INTO events (title, published_at, available_from, claims_close_at, pickup_deadline, status)
       VALUES ($1, NOW() - interval '2 hours', NOW() - interval '1 hour',
               NOW() + interval '2 hours', NOW() + interval '3 days', 'active')
       RETURNING id`,
      [`Daily Test Event ${stamp}`]
    );
    eventId = evRes.rows[0].id;

    // Forzar un límite diario conocido y recordar el previo para restaurarlo.
    const prev = await pool.query(
      `SELECT max_apartados_diarios FROM trust_levels_settings WHERE id = $1`,
      [TEST_ROLE]
    );
    previousDailyLimit = Number(prev.rows[0]?.max_apartados_diarios ?? 0);
    await pool.query(
      `UPDATE trust_levels_settings SET max_apartados_diarios = $2 WHERE id = $1`,
      [TEST_ROLE, TEST_DAILY_LIMIT]
    );

    const claim = (itemId: string) =>
      claimItem({ itemId, userUuid, username: `daily_test_${stamp}`, role: TEST_ROLE });

    // --- 1. Enforcement + aviso ---
    console.log('\nParte B.1: enforcement del cupo diario + aviso');
    const outcomes: any[] = [];
    for (let i = 1; i <= TEST_DAILY_LIMIT; i++) {
      outcomes.push(await claim(await newItem(i)));
    }
    check('claims 1..3 exitosos', outcomes.slice(0, 3).every((o) => o.ok === true));
    check(
      'claim 3 -> dailyRemaining 2 y dailyWarning true',
      outcomes[2].ok === true && outcomes[2].dailyRemaining === 2 && outcomes[2].dailyWarning === true,
      outcomes[2]
    );
    check(
      'claim 2 -> dailyWarning false (silencio)',
      outcomes[1].ok === true && outcomes[1].dailyWarning === false && outcomes[1].dailyRemaining === 3,
      outcomes[1]
    );
    const over = await claim(await newItem(99));
    check(
      'claim 6 -> daily_limit_exceeded (distinto)',
      over.ok === false && over.code === 'daily_limit_exceeded',
      over
    );

    // --- 2. Liberación voluntaria devuelve cupo ---
    console.log('\nParte B.2: liberar devuelve cupo del día');
    const claimedIds = (
      await pool.query(
        `SELECT item_id FROM claims WHERE user_uuid = $1 AND claim_state = 'active' ORDER BY claimed_at ASC LIMIT 1`,
        [userUuid]
      )
    ).rows;
    const leaveItem = claimedIds[0]?.item_id;
    const leave = await voluntarilyLeaveItem(leaveItem, userUuid);
    check('leave voluntario ok', leave.ok === true, leave);
    const afterLeave = await claim(await newItem(100));
    check('claim tras liberar -> ok (cupo devuelto)', afterLeave.ok === true, afterLeave);

    // --- 3. Expirio/void siguen contando ---
    console.log('\nParte B.3: expirio NO devuelve cupo');
    // Marcar como expirado el primer active restante.
    await pool.query(
      `UPDATE claims SET claim_state = 'expirado', updated_at = NOW()
       WHERE id = (SELECT id FROM claims WHERE user_uuid = $1 AND claim_state = 'active' ORDER BY claimed_at ASC LIMIT 1)`,
      [userUuid]
    );
    const afterExpire = await claim(await newItem(101));
    check(
      'claim tras expirio -> daily_limit_exceeded (el expirio cuenta)',
      afterExpire.ok === false && afterExpire.code === 'daily_limit_exceeded',
      afterExpire
    );

    // --- 4. Ventana libre exenta ---
    console.log('\nParte B.4: ventana libre sin límite diario');
    const freeWin = await claim(await newItem(102, 'ventana_libre'));
    check(
      'captura en ventana_libre -> ok pese al cupo agotado',
      freeWin.ok === true && freeWin.kind === 'free_window_capture',
      freeWin
    );

    // --- 5. Corte del día UTC-6 ---
    console.log('\nParte B.5: corte del día UTC-6');
    const spanUser = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (uuid, alias, global_role) VALUES ($1, $2, $3)`,
      [spanUser, `daily_span_${stamp}`, TEST_ROLE]
    );
    // Un claim de AYER no cuenta hoy: con límite 1, hoy todavía puede apartar.
    await pool.query(
      `INSERT INTO claims (item_id, user_uuid, claim_state, role_at_claim, claimed_at)
       VALUES ($1, $2, 'active', $3, NOW() - interval '30 hours')`,
      [await newItem(103), spanUser, TEST_ROLE]
    );
    const yesterdayPrev = await pool.query(
      `SELECT max_apartados_diarios FROM trust_levels_settings WHERE id = $1`,
      [TEST_ROLE]
    );
    await pool.query(
      `UPDATE trust_levels_settings SET max_apartados_diarios = 1 WHERE id = $1`,
      [TEST_ROLE]
    );
    const spanClaim = await claimItem({
      itemId: await newItem(104),
      userUuid: spanUser,
      username: `daily_span_${stamp}`,
      role: TEST_ROLE
    });
    check('claim de hoy con un claim de ayer -> ok (ayer no cuenta)', spanClaim.ok === true, spanClaim);
    await pool.query(
      `UPDATE trust_levels_settings SET max_apartados_diarios = $2 WHERE id = $1`,
      [TEST_ROLE, Number(yesterdayPrev.rows[0]?.max_apartados_diarios ?? TEST_DAILY_LIMIT)]
    );
  } finally {
    // Restaurar config y limpiar fixtures (cascade borra claims/items).
    if (previousDailyLimit !== null) {
      await pool.query(
        `UPDATE trust_levels_settings SET max_apartados_diarios = $2 WHERE id = $1`,
        [TEST_ROLE, previousDailyLimit]
      );
    }
    if (eventId) {
      await pool.query(`DELETE FROM items WHERE event_id = $1`, [eventId]);
      await pool.query(`DELETE FROM events WHERE id = $1`, [eventId]);
    }
    await pool.query(`DELETE FROM users WHERE uuid = ANY($1)`, [[userUuid, otherUuid]]);
    await pool.end();
  }
}

async function main(): Promise<void> {
  testPureHelpers();

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

  console.log(failures === 0 ? '\nTODO OK' : `\n${failures} fallo(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
