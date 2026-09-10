/**
 * shared/index.ts
 *
 * Central export point for shared modules across frontend and backend
 * (Estrategia temporal v2 — Fase 2, capa shared).
 *
 * NOTA DE ROMPIMIENTO TEMPORAL (por diseño, se arregla en Fases 3-4):
 * Se eliminaron exportaciones OBSOLETAS ligadas al schema legacy (D8):
 *  - eventHelpers: resolvePickupHoursField, buildRoleTimeline,
 *    calculateEffectiveAvailability, validateEventDates (y sus tipos
 *    EffectiveAvailability / RoleTimeline / EventBaseDates).
 *  - validators: validateBonusHours, validatePickupHours (no existen
 *    share_bonus ni pickup-hours en v2); validateEventInput ya NO valida
 *    columnas por rol.
 * Consumidores backend/frontend que aún importen esos símbolos romperán de
 * forma transitoria hasta su fase de adaptación (Fase 3 backend, Fase 4
 * frontend). shared/ compila de forma independiente.
 */

// Validators
export {
  validateItemInput,
  validateClaimInput,
  validateEmailFormat,
  validatePhoneFormat,
  isValidUrl,
  validateImageUrls,
  validateVisibilityLevel,
  validateRoleLevel,
  validateAdvanceHours,
  validateInvitationCode,
  validateEventInput,
  validateEventConfig,
  validateRoleDefaultsUpdate,
  validateMatrixAdvanceHours,
  validateFrozenSchedule,
  validateMarketFields
} from './validators.js';

export type { ValidationResult, ValidateEventInputOptions } from './validators.js';

// Event agenda configuration (single anchor -> public dates) + matriz de confianza
export {
  HOUR_MS,
  ADVANCE_HOURS_MIN,
  ADVANCE_HOURS_MAX,
  deriveEventSchedule
} from './eventConfig.js';

export type {
  EventConfig,
  DerivedEventSchedule,
  RoleConfigRow
} from './eventConfig.js';

// Event Helpers & Types (motor v2)
export {
  // Conservados
  ROLE_HIERARCHY,
  VALID_ROLES,
  EVENT_STATUSES,
  resolveEffectiveRole,
  determineRoleAfterInvitation,
  canUserSeeItem,
  generateInvitationCode,
  // Motor de recolección v2
  PICKUP_PCT,
  PUBLICO_FACTOR,
  V_MIN_FALLBACK,
  MAX_QUEUE_POSITIONS,
  shareForRole,
  computeVmin,
  computeTurnSlices,
  buildPickupSchedule,
  buildFrozenSchedule,
  // Ventajas dinámicas pub/disp
  visibleAtForRole,
  claimFromForRole,
  enforceVisibilityBeforeClaim,
  computeRoleTimeWindows,
  canClaimAt
} from './eventHelpers.js';

export type {
  RoleHierarchy,
  BuildPickupScheduleInput,
  BuildFrozenScheduleInput
} from './eventHelpers.js';

// Shared Types
export * from './types.js';
