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
  validateVisibilityLevel,
  validateRoleLevel,
  validateAdvanceHours,
  validateBonusHours,
  validateInvitationCode,
  validateEventInput
} from './validators.js';

export type { ValidationResult } from './validators.js';

// Event Helpers & Types
export {
  calculateEffectiveAvailability,
  determineRoleAfterInvitation,
  canUserSeeItem,
  generateInvitationCode,
  validateEventDates,
  ROLE_HIERARCHY,
  VALID_ROLES
} from './eventHelpers.js';

export type {
  EffectiveAvailability,
  RoleHierarchy
} from './eventHelpers.js';

// Shared Types
export * from './types.js';
