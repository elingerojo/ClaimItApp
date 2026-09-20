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
  DESCRIPTION_DETAIL_MAX_LENGTH,
  validateDescriptionDetail,
  validateConditionGrade,
  validateConditionPackaging,
  validateConditionAccessories,
  validateConditionUsage,
  validateConditionFunctionality,
  validateItemConditionFields,
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
  CLAIM_DAY_TIMEZONE,
  DAILY_WARNING_FRACTION,
  dailyWarningThreshold,
  dailyClaimStatus,
  deriveEventSchedule
} from './eventConfig.js';

export type {
  EventConfig,
  DerivedEventSchedule,
  RoleConfigRow,
  DailyClaimStatus
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

// Item physical condition domain (SP3): catálogo ordenado de `condition_grade`
// (rank 7→1), vocabularios de los 4 calificadores, etiquetas ES y helpers de
// orden/búsqueda/tono. Dominio agnóstico de framework (sin clases CSS).
export {
  CONDITION_GRADE_TONES,
  CONDITION_GRADE_CATALOG,
  CONDITION_GRADES_ORDERED,
  CONDITION_GRADE_ORDER,
  getConditionGradeEntry,
  isConditionGrade,
  conditionGradeLabel,
  conditionGradeTone,
  CONDITION_PACKAGING_FIELD_LABEL,
  CONDITION_PACKAGING_VALUES,
  CONDITION_PACKAGING_LABELS,
  CONDITION_PACKAGING_OPTIONS,
  isConditionPackaging,
  CONDITION_ACCESSORIES_FIELD_LABEL,
  CONDITION_ACCESSORIES_VALUES,
  CONDITION_ACCESSORIES_LABELS,
  CONDITION_ACCESSORIES_OPTIONS,
  isConditionAccessories,
  CONDITION_USAGE_FIELD_LABEL,
  CONDITION_USAGE_VALUES,
  CONDITION_USAGE_LABELS,
  CONDITION_USAGE_OPTIONS,
  isConditionUsage,
  CONDITION_FUNCTIONALITY_FIELD_LABEL,
  CONDITION_FUNCTIONALITY_VALUES,
  CONDITION_FUNCTIONALITY_LABELS,
  CONDITION_FUNCTIONALITY_OPTIONS,
  isConditionFunctionality
} from './itemCondition.js';

export { CONDITION_COLUMN_BY_FIELD } from './itemCondition.js';

export type {
  ConditionGradeTone,
  ConditionGradeEntry,
  ConditionQualifierOption,
  ConditionFieldName
} from './itemCondition.js';

// Shared Types
export * from './types.js';
