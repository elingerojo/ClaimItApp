/**
 * shared/eventHelpers.ts — MOTOR DE LA ESTRATEGIA TEMPORAL v2 (capa shared).
 *
 * Este módulo implementa las reglas DETERMINISTAS del plan
 * `plans/estrategia-temporal-v2.md` (§4). Todo es PURO y sin DB:
 *
 *   - Motor de recolección (porciones FIFO del contenedor rígido):
 *       * PICKUP_PCT (familiares 25% / amigos 20% / conocidos 15%),
 *       * público = 0.60 · Vmin, ventana libre = 100% − Σ,
 *       * computeVmin / computeTurnSlices / buildPickupSchedule.
 *   - Serialización del snapshot congelado (buildFrozenSchedule) con el mismo
 *     contrato snake_case de `items.frozen_schedule` (ver shared/types.ts).
 *   - Ventajas por rol DINÁMICAS (cero columnas por evento): helpers que dados
 *     `publishedAt`/`availableFrom` y la matriz (`advance_pub/disp_hours_default`)
 *     calculan visibleAtForRole y claimFromForRole con la regla de consistencia
 *     "nunca se reclama sin ver" (clamp defensivo si la config lo violara).
 *
 * Legado OBSOLETO eliminado (D8): resolvePickupHoursField, buildRoleTimeline,
 * calculateEffectiveAvailability, validateEventDates (no hay más columnas por
 * rol ni pickup-hours/share-bonus ni línea de tiempo simétrica por evento).
 * Los consumidores backend que aún los importen se adaptan en la Fase 3.
 */

import type {
  FifoPosition,
  Role,
  TurnSlice,
  PickupSchedule,
  FrozenSchedule,
  FrozenSchedulePosition,
  EventStatus
} from './types.js';
import { HOUR_MS } from './eventConfig.js';

// ---------------------------------------------------------------------------
// Jerarquía y roles
// ---------------------------------------------------------------------------

/** Niveles de jerarquía (1 = mayor privilegio). */
export type RoleHierarchy = Readonly<Record<Role, number>>;

export const ROLE_HIERARCHY: RoleHierarchy = {
  familiares: 1,
  amigos: 2,
  conocidos: 3,
  publico: 4
} as const;

export const VALID_ROLES: readonly Role[] = ['familiares', 'amigos', 'conocidos', 'publico'];

/**
 * Rol efectivo de un usuario en v2. La membresía por evento ya NO tiene rol
 * (migración 0002); el rol global de `users` es la única fuente de verdad.
 * Se conserva la firma con `membershipRole` por compatibilidad de call-sites,
 * pero en v2 siempre es null → se resuelve `globalRole || 'publico'`.
 */
export function resolveEffectiveRole(
  membershipRole: string | null | undefined,
  globalRole: string | null | undefined
): string {
  return globalRole || membershipRole || 'publico';
}

/**
 * Decide si un rol debe ascender tras aceptar una invitación de rol superior.
 * CONSERVADO (D7): las invitaciones en cascada por rol siguen existiendo y el
 * rol global del usuario es la fuente de verdad; aceptar un código de mayor
 * privilegio actualiza el rol global.
 */
export function determineRoleAfterInvitation(
  currentRole: string,
  invitationRole: string
): string {
  const currentLevel = ROLE_HIERARCHY[currentRole as Role] ?? ROLE_HIERARCHY['publico'];
  const invitationLevel = ROLE_HIERARCHY[invitationRole as Role] ?? ROLE_HIERARCHY['publico'];
  // Lower level = higher privilege, so upgrade if invitation has lower level
  return invitationLevel < currentLevel ? invitationRole : currentRole;
}

/**
 * Chequea si un rol puede ver un item según `visibility_level`
 * (0=admin only, 1=familiares, 2=amigos, 3=conocidos, 4=publico).
 * CONSERVADO (D7): el subsistema de visibilidad por nivel se mantiene.
 */
export function canUserSeeItem(userRole: string, visibilityLevel: number): boolean {
  const userLevel = ROLE_HIERARCHY[userRole as Role] ?? ROLE_HIERARCHY['publico'];
  return userLevel <= visibilityLevel;
}

/** Código de invitación críptico (16 alfanuméricos). CONSERVADO (D7). */
export function generateInvitationCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/** Estados de evento (final set): draft → scheduled → active → closing → closed. */
export const EVENT_STATUSES: readonly EventStatus[] = [
  'draft',
  'scheduled',
  'active',
  'closing',
  'closed'
];

// ---------------------------------------------------------------------------
// Motor de recolección — constantes fijas NO configurables (D4)
// ---------------------------------------------------------------------------

/** Porción fija por rol privilegiado (fracción 0..1 del contenedor). */
export const PICKUP_PCT = {
  familiares: 0.25,
  amigos: 0.2,
  conocidos: 0.15
} as const;

/** Factor del rol público: público = PUBLICO_FACTOR · Vmin (0.60). */
export const PUBLICO_FACTOR = 0.6;

/**
 * Vmin de respaldo: % del rol con ventaja de menor jerarquía presente cuando
 * solo hay público o la cola está vacía → 15% (0.15).
 */
export const V_MIN_FALLBACK = 0.15;

/** Máximo de posiciones FIFO por item. */
export const MAX_QUEUE_POSITIONS = 3;

/** Roles con ventaja (porción fija > 0). El público no: su porción es 0.60·Vmin. */
const ADVANTAGE_ROLES: readonly Exclude<Role, 'publico'>[] = ['familiares', 'amigos', 'conocidos'];

function isAdvantageRole(role: Role | null | undefined): role is Exclude<Role, 'publico'> {
  return role === 'familiares' || role === 'amigos' || role === 'conocidos';
}

/**
 * Porción (0..1) que consume una posición según su rol:
 *   familiares 0.25, amigos 0.20, conocidos 0.15, público 0.60·Vmin, vacía 0.
 */
export function shareForRole(role: Role | null | undefined, vmin: number): number {
  if (role === null || role === undefined) return 0;
  if (role === 'publico') return PUBLICO_FACTOR * vmin;
  return PICKUP_PCT[role];
}

/**
 * Vmin = % del rol con ventaja de menor jerarquía PRESENTE en la cola.
 * Solo cuentan familiares/amigos/conocidos; si solo hay público o la cola está
 * vacía → V_MIN_FALLBACK (0.15). Retorna fracción 0..1.
 */
export function computeVmin(queueRoles: ReadonlyArray<Role | null | undefined>): number {
  let min = Infinity;
  let found = false;
  for (const role of queueRoles) {
    if (isAdvantageRole(role)) {
      min = Math.min(min, PICKUP_PCT[role]);
      found = true;
    }
  }
  return found ? min : V_MIN_FALLBACK;
}

/**
 * Porciones por posición (1..MAX_QUEUE_POSITIONS) dadas las posiciones de la
 * FIFO. `queueRoles` se normaliza a exactamente 3 slots (se rellena con null).
 * Retorna la fracción 0..1 de cada posición y su rol (null si vacía).
 */
export function computeTurnSlices(
  queueRoles: ReadonlyArray<Role | null | undefined>
): TurnSlice[] {
  const vmin = computeVmin(queueRoles);
  const slices: TurnSlice[] = [];
  for (let i = 0; i < MAX_QUEUE_POSITIONS; i++) {
    const role = (queueRoles[i] as Role | null | undefined) ?? null;
    slices.push({
      position: (i + 1) as FifoPosition,
      role,
      share: shareForRole(role, vmin)
    });
  }
  return slices;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIsoMs(value: Date | string): number {
  const d = toDate(value);
  const ms = d.getTime();
  if (Number.isNaN(ms)) throw new Error(`buildPickupSchedule: fecha inválida: ${String(value)}`);
  return ms;
}

export interface BuildPickupScheduleInput {
  /** claims_close_at = T_inicio (ISO o Date). */
  claimsCloseAt: Date | string;
  /** pickup_deadline = T_final (ISO o Date). */
  pickupDeadline: Date | string;
  /** Posiciones de la FIFO (rol por orden de claim, hasta 3). */
  queueRoles: ReadonlyArray<Role | null | undefined>;
}

/**
 * Construye el calendario v2 de recolección de forma PURA y DETERMINISTA:
 *
 *   C_total = pickup_deadline − claims_close_at
 *   V1 = T_inicio + C_total·s1
 *   V2 = V1       + C_total·s2
 *   V3 = V2       + C_total·s3
 *
 * freeWindowStart = V de la última posición ocupada (V3 si la pos 3 está
 * ocupada); si la cola quedó vacía → claims_close_at (100% libre).
 * charityAt = pickup_deadline.
 */
export function buildPickupSchedule(input: BuildPickupScheduleInput): PickupSchedule {
  const tInicio = toIsoMs(input.claimsCloseAt);
  const tFinal = toIsoMs(input.pickupDeadline);
  if (tFinal <= tInicio) {
    throw new Error('buildPickupSchedule: pickup_deadline debe ser posterior a claims_close_at');
  }
  const cTotal = tFinal - tInicio; // ms
  const cTotalSeconds = Math.round(cTotal / 1000);

  const slices = computeTurnSlices(input.queueRoles);
  const vmin = computeVmin(input.queueRoles);

  // Vencimientos acumulativos por posición (números absolutos en ms).
  const boundaries: number[] = [];
  let cursor = tInicio;
  for (let i = 0; i < slices.length; i++) {
    cursor += cTotal * slices[i].share;
    boundaries[i] = cursor;
  }

  const iso = (ms: number): string => new Date(ms).toISOString();

  const positionOccupied: boolean[] = slices.map((s) => s.role !== null);
  const vExpires: (string | null)[] = slices.map((s, i) =>
    positionOccupied[i] ? iso(boundaries[i]) : null
  );

  // Última posición legítimamente ocupada (mayor índice con rol).
  let lastOccupied = -1;
  for (let i = slices.length - 1; i >= 0; i--) {
    if (positionOccupied[i]) {
      lastOccupied = i;
      break;
    }
  }

  const freeWindowStart =
    lastOccupied >= 0 ? iso(boundaries[lastOccupied]) : iso(tInicio);

  return {
    claimsCloseAt: iso(tInicio),
    pickupDeadline: iso(tFinal),
    cTotalSeconds,
    vmin,
    v1: vExpires[0],
    v2: vExpires[1],
    v3: vExpires[2],
    freeWindowStart,
    charityAt: iso(tFinal),
    slices
  };
}

// ---------------------------------------------------------------------------
// Serialización del snapshot congelado (items.frozen_schedule JSONB)
// ---------------------------------------------------------------------------

export interface BuildFrozenScheduleInput {
  /** Instante real del congelamiento (ISO). Default: claims_close_at. */
  frozenAt?: Date | string;
  /** claims_close_at = T_inicio. */
  claimsCloseAt: Date | string;
  /** pickup_deadline = T_final. */
  pickupDeadline: Date | string;
  /** FIFO al congelar: rol y claim_id por posición (hasta 3, en orden). */
  queue: ReadonlyArray<{ role: Role | null; claimId: string | null }>;
}

/**
 * Serializa el snapshot congelado idempotente que la Fase 3 persistirá en
 * `items.frozen_schedule`. Es puro (no toca la BD) y reproduce las llaves
 * snake_case documentadas en `database/init.sql` §items.
 */
export function buildFrozenSchedule(input: BuildFrozenScheduleInput): FrozenSchedule {
  const claimsCloseAt = toIsoMs(input.claimsCloseAt);
  const pickupDeadline = toIsoMs(input.pickupDeadline);
  if (pickupDeadline <= claimsCloseAt) {
    throw new Error('buildFrozenSchedule: pickup_deadline debe ser posterior a claims_close_at');
  }
  const cTotal = pickupDeadline - claimsCloseAt;
  const frozenAt = input.frozenAt ? toIsoMs(input.frozenAt) : claimsCloseAt;

  const roles: (Role | null)[] = [];
  for (let i = 0; i < MAX_QUEUE_POSITIONS; i++) {
    roles.push(input.queue[i]?.role ?? null);
  }
  const schedule = buildPickupSchedule({ claimsCloseAt: input.claimsCloseAt, pickupDeadline: input.pickupDeadline, queueRoles: roles });

  // v_expires_at de cada posición ocupada = su V fijo (v1/v2/v3).
  const vOf: (string | null)[] = [schedule.v1, schedule.v2, schedule.v3];
  const positions: FrozenSchedulePosition[] = [];
  for (let i = 0; i < MAX_QUEUE_POSITIONS; i++) {
    const entry = input.queue[i];
    if (!entry || entry.role === null) continue; // solo posiciones ocupadas
    positions.push({
      claim_id: entry.claimId ?? '',
      position: (i + 1) as FifoPosition,
      role: entry.role,
      share_pct: Math.round(schedule.slices[i].share * 100),
      v_expires_at: vOf[i] ?? schedule.claimsCloseAt
    });
  }

  return {
    version: 2,
    frozen_at: new Date(frozenAt).toISOString(),
    t_inicio: schedule.claimsCloseAt,
    t_final: schedule.pickupDeadline,
    c_total_seconds: schedule.cTotalSeconds,
    vmin_pct: Math.round(schedule.vmin * 100),
    v1: schedule.v1,
    v2: schedule.v2,
    v3: schedule.v3,
    ventana_libre_starts_at: schedule.freeWindowStart,
    charity_at: schedule.charityAt,
    positions
  };
}

// ---------------------------------------------------------------------------
// Ventajas por rol DINÁMICAS (publicación / "Lo quiero") — D3
// ---------------------------------------------------------------------------

/**
 * Instante de VISIBILIDAD para el rol:
 *   visibleAtForRole = published_at − advance_pub_hours(rol)
 * Si published_at es null (evento sin publicar), no hay visibilidad → null.
 */
export function visibleAtForRole(
  publishedAt: Date | string | null | undefined,
  advancePubHours: number
): Date | null {
  if (publishedAt === null || publishedAt === undefined || publishedAt === '') return null;
  const pub = toDate(publishedAt);
  const ms = pub.getTime() - (advancePubHours || 0) * HOUR_MS;
  return new Date(ms);
}

/**
 * Instante de INICIO DE CLAIM ("Lo quiero") para el rol:
 *   claimFromForRole = available_from − advance_disp_hours(rol)
 */
export function claimFromForRole(
  availableFrom: Date | string,
  advanceDispHours: number
): Date {
  const avail = toDate(availableFrom);
  const ms = avail.getTime() - (advanceDispHours || 0) * HOUR_MS;
  return new Date(ms);
}

/**
 * Regla de consistencia "nunca se reclama sin ver": el instante de visibilidad
 * debe ser <= al instante de inicio de claim. La matriz ya lo garantiza con el
 * CHECK advance_disp <= advance_pub y con available_from >= published_at
 * (plantilla de agenda), pero este clamp es la defensa por si acaso: si por
 * algún dato incoherente claimFrom < visibleAt, se retrasa el claim al instante
 * de visibilidad (nadie reclama antes de ver el item).
 */
export function enforceVisibilityBeforeClaim(
  visibleAt: Date | null,
  claimFrom: Date
): { visibleAt: Date | null; claimFrom: Date } {
  if (visibleAt === null) return { visibleAt, claimFrom };
  const vMs = visibleAt.getTime();
  const cMs = claimFrom.getTime();
  if (cMs < vMs) {
    return { visibleAt, claimFrom: new Date(vMs) };
  }
  return { visibleAt, claimFrom };
}

/** Conveniencia: ambos instantes + regla de consistencia aplicada. */
export function computeRoleTimeWindows(opts: {
  publishedAt: Date | string | null | undefined;
  availableFrom: Date | string;
  advancePubHours: number;
  advanceDispHours: number;
}): { visibleAt: Date | null; claimFrom: Date } {
  const visibleAt = visibleAtForRole(opts.publishedAt, opts.advancePubHours);
  const claimFrom = claimFromForRole(opts.availableFrom, opts.advanceDispHours);
  return enforceVisibilityBeforeClaim(visibleAt, claimFrom);
}

/**
 * Determina si el botón "Lo quiero" está habilitado para el rol en `now`:
 *   now >= claim_from(rol)  Y  now < claims_close_at (T_inicio)
 */
export function canClaimAt(opts: {
  now: Date | string;
  availableFrom: Date | string;
  advanceDispHours: number;
  claimsCloseAt: Date | string | null | undefined;
}): boolean {
  const now = toIsoMs(opts.now);
  const claimFrom = toIsoMs(
    claimFromForRole(opts.availableFrom, opts.advanceDispHours)
  );
  if (now < claimFrom) return false;
  if (opts.claimsCloseAt !== null && opts.claimsCloseAt !== undefined && opts.claimsCloseAt !== '') {
    if (now >= toIsoMs(opts.claimsCloseAt)) return false;
  }
  return true;
}
