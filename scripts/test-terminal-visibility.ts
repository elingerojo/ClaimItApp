/**
 * scripts/test-terminal-visibility.ts
 *
 * Verifica la función PURA `isTerminalItemExpiredForVisitor` (shared), que
 * decide si un objeto TERMINAL (`entregado` / `enviado_a_caridad`) debe
 * ocultarse del catálogo del visitante (`GET /api/items`) al superar
 * `terminal_visibility_hours` (default 72 h = 3 días) desde su cierre
 * (`delivered_at` / `charity_at`).
 *
 * Sin BD ni backend: solo el helper compartido (reloj inyectado).
 *
 * Uso:
 *   npx tsx scripts/test-terminal-visibility.ts
 */
import { HOUR_MS, isTerminalItemExpiredForVisitor } from '@claimitapp/shared';

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

console.log('\n-- fases no terminales --');
check(
  'claim_open NO se oculta',
  isTerminalItemExpiredForVisitor('claim_open', iso(100 * HOUR_MS), 72, now) === false
);
check(
  'pickup_turns NO se oculta',
  isTerminalItemExpiredForVisitor('pickup_turns', iso(100 * HOUR_MS), 72, now) === false
);
check(
  'ventana_libre NO se oculta',
  isTerminalItemExpiredForVisitor('ventana_libre', iso(100 * HOUR_MS), 72, now) === false
);

console.log('\n-- entregado (default 72 h) --');
check(
  'entregado reciente (1 h) no se oculta',
  isTerminalItemExpiredForVisitor('entregado', iso(1 * HOUR_MS), 72, now) === false
);
check(
  'entregado justo en el límite (72 h) NO se oculta',
  isTerminalItemExpiredForVisitor('entregado', iso(72 * HOUR_MS), 72, now) === false
);
check(
  'entregado 72 h + 1 s SÍ se oculta',
  isTerminalItemExpiredForVisitor('entregado', iso(72 * HOUR_MS + 1000), 72, now) === true
);
check(
  'entregado 4 d SÍ se oculta',
  isTerminalItemExpiredForVisitor('entregado', iso(96 * HOUR_MS), 72, now) === true
);

console.log('\n-- enviado_a_caridad (default 72 h) --');
check(
  'caridad reciente (1 h) no se oculta',
  isTerminalItemExpiredForVisitor('enviado_a_caridad', iso(1 * HOUR_MS), 72, now) === false
);
check(
  'caridad justo en el límite (72 h) NO se oculta',
  isTerminalItemExpiredForVisitor('enviado_a_caridad', iso(72 * HOUR_MS), 72, now) === false
);
check(
  'caridad 73 h SÍ se oculta',
  isTerminalItemExpiredForVisitor('enviado_a_caridad', iso(73 * HOUR_MS), 72, now) === true
);

console.log('\n-- bordes --');
check(
  'sin marca temporal NO se oculta',
  isTerminalItemExpiredForVisitor('entregado', null, 72, now) === false
);
check(
  'fecha inválida NO se oculta',
  isTerminalItemExpiredForVisitor('enviado_a_caridad', 'no-es-fecha', 72, now) === false
);
check(
  'cierre futuro NO se oculta',
  isTerminalItemExpiredForVisitor('entregado', iso(-10 * HOUR_MS), 72, now) === false
);

console.log('\n-- umbral configurable y 0 = ocultar de inmediato --');
check(
  'umbral 0 oculta cualquier terminal pasado',
  isTerminalItemExpiredForVisitor('entregado', iso(1000), 0, now) === true
);
check(
  'umbral 168 h (7 d): 73 h NO se oculta',
  isTerminalItemExpiredForVisitor('enviado_a_caridad', iso(73 * HOUR_MS), 168, now) === false
);
check(
  'umbral 168 h (7 d): 169 h SÍ se oculta',
  isTerminalItemExpiredForVisitor('entregado', iso(169 * HOUR_MS), 168, now) === true
);
check(
  'umbral NaN cae al default 72 h',
  isTerminalItemExpiredForVisitor('entregado', iso(73 * HOUR_MS), Number.NaN, now) === true
);

console.log(
  failures === 0
    ? '\n✅ Todas las verificaciones de visibilidad terminal pasaron.'
    : `\n❌ ${failures} verificación(es) fallaron.`
);
process.exit(failures === 0 ? 0 : 1);
