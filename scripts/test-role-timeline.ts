/*
 * ⚠️ LEGACY / OBSOLETO — Estrategia temporal v2 (Fase 5): importa buildRoleTimeline
 * (ventanas simétricas por rol) que fue ELIMINADO de shared (D8: cero columnas por evento;
 * la línea de tiempo ahora es el contenedor rígido V1..V3 del motor). No compila/corre.
 * Conservado solo como referencia histórica. Verificación E2E vigente:
 *   npx tsx scripts/test-v2-strategy.ts
 */
/**
 * scripts/test-role-timeline.ts
 *
 * Pure (no DB) regression test for the symmetric per-role window helper:
 *   - A = 0 (publico) keeps the exact public base timeline;
 *   - start dates (published_at, available_from) shift EARLIER  → base − A;
 *   - end dates (claims_close_at, pickup_deadline) shift LATER  → base + A;
 *   - null dates stay null.
 *
 * Run: npx tsx scripts/test-role-timeline.ts
 */
import { buildRoleTimeline } from '../shared/dist/eventHelpers.js';

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

const H = 60 * 60 * 1000;
const base = {
  publishedAt: '2026-09-08T02:55:00.000Z',
  availableFrom: '2026-09-09T02:55:00.000Z',
  claimsCloseAt: '2026-09-12T02:55:00.000Z',
  pickupDeadline: '2026-09-14T02:55:00.000Z'
};

// 1. publico (A=0) -> identical to base.
{
  const t = buildRoleTimeline(base, 0);
  check('A=0 published unchanged', t.publishedAt?.toISOString() === base.publishedAt);
  check('A=0 available unchanged', t.availableFrom?.toISOString() === base.availableFrom);
  check('A=0 claims_close unchanged', t.claimsCloseAt?.toISOString() === base.claimsCloseAt);
  check('A=0 pickup unchanged', t.pickupDeadline?.toISOString() === base.pickupDeadline);
}

// 2. familiares A=72h -> published −72h, available −72h, claims_close +72h, pickup +72h.
{
  const A = 72;
  const t = buildRoleTimeline(base, A);
  check('totalAdvanceHours recorded', t.totalAdvanceHours === A);
  check(
    'published −72h (earlier)',
    t.publishedAt?.getTime() === new Date(base.publishedAt).getTime() - A * H
  );
  check(
    'available −72h (earlier)',
    t.availableFrom?.getTime() === new Date(base.availableFrom).getTime() - A * H
  );
  check(
    'claims_close +72h (later)',
    t.claimsCloseAt?.getTime() === new Date(base.claimsCloseAt).getTime() + A * H
  );
  check(
    'pickup_deadline +72h (later)',
    t.pickupDeadline?.getTime() === new Date(base.pickupDeadline).getTime() + A * H
  );
}

// 3. Negative advance is clamped to 0 (never widens the wrong way).
{
  const t = buildRoleTimeline(base, -50);
  check('negative A clamped to 0', t.totalAdvanceHours === 0 && t.availableFrom?.toISOString() === base.availableFrom);
}

// 4. Null dates preserved.
{
  const t = buildRoleTimeline({ publishedAt: null, availableFrom: undefined, claimsCloseAt: null, pickupDeadline: '2026-09-14T02:55:00.000Z' }, 24);
  check('null published stays null', t.publishedAt === null);
  check('null available stays null', t.availableFrom === null);
  check('null claims_close stays null', t.claimsCloseAt === null);
  check('present pickup widens +24h', t.pickupDeadline?.getTime() === new Date('2026-09-14T02:55:00.000Z').getTime() + 24 * H);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
