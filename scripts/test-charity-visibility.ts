/**
 * scripts/test-charity-visibility.ts
 *
 * Verifica la función PURA `isCharityItemExpiredForVisitor` (shared), que decide
 * si un objeto en fase `enviado_a_caridad` debe ocultarse del catálogo del
 * visitante (`GET /api/items`) cuando supera `charity_visibility_hours`
 * (default 72 h = 3 días) desde `charity_at`.
 *
 * Sin BD ni backend: solo el helper compartido (reloj inyectado).
 *
 * Uso:
 *   npx tsx scripts/test-charity-visibility.ts
 */
import { HOUR_MS, isCharityItemExpiredForVisitor } from '@claimitapp/shared';

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  if (condition) console.log(`  PASS: ${label}`);
  else {
    failures++;
    console.error(`  FAIL: ${label}`, extra ?? '');
  }
}

const now = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

console.log('\n-- isCharityItemExpiredForVisitor (default 72 h) --');
check(
  'no aplica a fase no-terminal',
  isCharityItemExpiredForVisitor('claim_open', iso(100 * HOUR_MS), null, 72, now) === false
);
check(
  'charity reciente (1 h) no se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(1 * HOUR_MS), null, 72, now) === false
);
check(
  'charity justo en el límite (72 h) NO se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(72 * HOUR_MS), null, 72, now) === false
);
check(
  'charity 72 h + 1 s SÍ se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(72 * HOUR_MS + 1000), null, 72, now) === true
);
check(
  'charity 3 d + 1 h SÍ se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(73 * HOUR_MS), null, 72, now) === true
);
check(
  'charity 4 d SÍ se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(96 * HOUR_MS), null, 72, now) === true
);

console.log('\n-- Fallback y bordes --');
check(
  'sin charity_at usa pickup_deadline',
  isCharityItemExpiredForVisitor('enviado_a_caridad', null, iso(73 * HOUR_MS), 72, now) === true
);
check(
  'sin marca temporal NO se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', null, null, 72, now) === false
);
check(
  'fecha inválida NO se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', 'no-es-fecha', null, 72, now) === false
);
check(
  'charity futuro NO se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(-10 * HOUR_MS), null, 72, now) === false
);

console.log('\n-- Umbral configurable y 0 = ocultar de inmediato --');
check(
  'umbral 0 oculta cualquier charity pasado',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(1000), null, 0, now) === true
);
check(
  'umbral 168 h (7 d): 73 h NO se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(73 * HOUR_MS), null, 168, now) === false
);
check(
  'umbral 168 h (7 d): 169 h SÍ se oculta',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(169 * HOUR_MS), null, 168, now) === true
);
check(
  'umbral NaN cae al default 72 h',
  isCharityItemExpiredForVisitor('enviado_a_caridad', iso(73 * HOUR_MS), null, Number.NaN, now) === true
);

console.log(
  failures === 0
    ? '\n✅ Todas las verificaciones de visibilidad de caridad pasaron.'
    : `\n❌ ${failures} verificación(es) fallaron.`
);
process.exit(failures === 0 ? 0 : 1);
