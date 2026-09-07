/**
 * scripts/smoke-role-feed.ts
 *
 * Smoke test (READ-ONLY) of the new per-role symmetric-window feed logic.
 * Rehydrates the RAM store from Neon and calls the REAL getInventoryFeed for
 * two users of the current single event, printing what each role sees and the
 * effective (widened) dates, to verify:
 *   - start dates shift EARLIER  (published − A, available − A),
 *   - end dates shift LATER      (claims_close + A, pickup_deadline + A),
 *   - familiares sees the catalog BEFORE the public base publication,
 *   - publico (A = 0) keeps the exact public base timeline.
 *
 * Run: npx tsx scripts/smoke-role-feed.ts
 */
import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../backend/src/config/db.js';
import { rehydrateAll } from '../backend/src/cache/appStore.js';
import { getInventoryFeed } from '../backend/src/controllers/feedsController.js';

dotenv.config({ path: path.resolve('backend/.env') });

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

async function feedFor(query: Record<string, string>): Promise<any[]> {
  const res = mockRes();
  await getInventoryFeed({ query } as any, res);
  return res._json;
}

async function main(): Promise<void> {
  const now = Date.now();
  console.log('=== AHORA ===', new Date(now).toISOString(), '(UTC)\n');

  // Rehydrate the RAM store from Neon (idempotent; then feed reads from store).
  await rehydrateAll();

  const users = await pool.query('SELECT uuid, alias, global_role FROM users');
  console.log('=== NEON users ===');
  for (const u of users.rows) console.log(`  ${u.alias} (${u.global_role}) -> ${u.uuid}`);

  const events = await pool.query(
    `SELECT title, published_at, available_from, claims_close_at, pickup_deadline,
            familiares_advance_hours, amigos_advance_hours,
            conocidos_advance_hours, publico_advance_hours
     FROM events ORDER BY created_at`
  );
  console.log('\n=== NEON event base (public) dates ===');
  const ev = events.rows[0];
  if (ev) {
    console.log(`  title          : ${ev.title}`);
    console.log(`  published_at   : ${ev.published_at}  (${new Date(ev.published_at).toISOString()})`);
    console.log(`  available_from : ${ev.available_from}  (${new Date(ev.available_from).toISOString()})`);
    console.log(`  claims_close_at: ${ev.claims_close_at}  (${new Date(ev.claims_close_at).toISOString()})`);
    console.log(`  pickup_deadline: ${ev.pickup_deadline}  (${new Date(ev.pickup_deadline).toISOString()})`);
    console.log(`  advance: familiares=${ev.familiares_advance_hours} amigos=${ev.amigos_advance_hours} conocidos=${ev.conocidos_advance_hours} publico=${ev.publico_advance_hours}`);
  }

  const H = 60 * 60 * 1000;
  function iso(d: string | null, deltaH: number): string {
    return d ? new Date(new Date(d).getTime() + deltaH * H).toISOString() : 'n/a';
  }

  console.log('\n=== Expected per-role timeline (base ± advance) ===');
  for (const [role, adv] of [['publico', 0], ['conocidos', 0], ['amigos', 24], ['familiares', 72]] as const) {
    const A = adv;
    console.log(`  ${role.padEnd(10)} A=${A}h`);
    console.log(`     published     = ${iso(ev.published_at, -A)}`);
    console.log(`     available     = ${iso(ev.available_from, -A)}`);
    console.log(`     claims_close  = ${iso(ev.claims_close_at, A)}`);
    console.log(`     pickup_dead   = ${iso(ev.pickup_deadline, A)}`);
  }

  // PUBLICO: no userUuid -> base public timeline (A=0).
  const pub = await feedFor({});
  console.log(`\n=== FEED público (sin userUuid): ${Array.isArray(pub) ? pub.length : 'N/A'} items ===`);
  if (Array.isArray(pub)) {
    console.log('  (esperado 0 mientras published_at público no llegue; visible hoy a las ' +
      new Date(ev.published_at).toISOString() + ')');
    for (const it of pub.slice(0, 3)) {
      console.log(`  - ${it.title} | canClaim=${it.canClaim}`);
    }
  }

  // FAMILIARES: SoyLalo.
  const fam = users.rows.find((u: any) => u.global_role === 'familiares');
  if (fam) {
    const list = await feedFor({ userUuid: fam.uuid });
    console.log(`\n=== FEED familiares (${fam.alias} ${fam.uuid}): ${Array.isArray(list) ? list.length : 'N/A'} items ===`);
    if (Array.isArray(list)) {
      console.log(`  (esperado ${'#'}items visibles YA, porque published−72h ya pasó)`);
      for (const it of list.slice(0, 3)) {
        console.log(`  - ${it.title}`);
        console.log(`      myRole=${it.myRoleInEvent} canClaim=${it.canClaim} claimsClosed=${it.claimsClosed}`);
        console.log(`      base availableFrom   = ${it.availableFrom}`);
        console.log(`      effectiveAvailFrom   = ${it.effectiveAvailableFrom}`);
        console.log(`      effectiveClaimsClose = ${it.effectiveClaimsCloseAt}`);
        console.log(`      effectivePickupDead  = ${it.effectivePickupDeadline}`);
      }
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
