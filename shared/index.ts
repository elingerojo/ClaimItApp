/**
 * shared/index.ts
 *
 * Central export point for shared modules across frontend and backend
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
  validateBonusHours,
  validatePickupHours,
  validateInvitationCode,
  validateEventInput,
  validateEventConfig,
  validateRoleDefaultsUpdate
} from './validators.js';

export type { ValidationResult } from './validators.js';

// Event agenda configuration (single anchor -> public dates)
export {
  HOUR_MS,
  deriveEventSchedule
} from './eventConfig.js';

export type {
  EventConfig,
  DerivedEventSchedule,
  RoleConfigRow
} from './eventConfig.js';

// Event Helpers & Types
export {
  calculateEffectiveAvailability,
  determineRoleAfterInvitation,
  canUserSeeItem,
  generateInvitationCode,
  validateEventDates,
  ROLE_HIERARCHY,
  VALID_ROLES,
  EVENT_STATUSES,
  resolvePickupHoursField,
  resolveEffectiveRole
} from './eventHelpers.js';

export type {
  EffectiveAvailability,
  RoleHierarchy
} from './eventHelpers.js';

// Shared Types
export * from './types.js';
