/**
 * shared/validators.ts
 * 
 * Validation functions for data integrity across backend and frontend.
 * Used to prevent operational errors (accidental invalid submissions).
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate item creation/update input
 */
export function validateItemInput(data: any): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!data.title?.trim() || data.title.length < 3) {
    errors.push('Title: minimum 3 characters required');
  }
  if (!data.description?.trim() || data.description.length < 10) {
    errors.push('Description: minimum 10 characters required');
  }
  if (!data.category) {
    errors.push('Category: required');
  }
  if (!data.imageUrl?.trim()) {
    errors.push('Image URL: required');
  }

  // Optional fields validation
  if (data.infoUrl && data.infoUrl.trim()) {
    if (!isValidUrl(data.infoUrl)) {
      errors.push('Info URL: invalid URL format');
    }
  }

  // Conditional validation for Roles/Events feature
  if (data.visibility_level !== undefined) {
    if (!validateVisibilityLevel(data.visibility_level)) {
      errors.push('visibility_level: must be between 0 and 4');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate claim submission input
 */
export function validateClaimInput(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data.itemId?.trim()) {
    errors.push('itemId: required');
  }
  if (!data.userUuid?.trim()) {
    errors.push('userUuid: required');
  }

  // Optional contact validation
  if (data.email && data.email.trim()) {
    if (!validateEmailFormat(data.email)) {
      errors.push('Email: invalid format');
    }
  }
  if (data.phone && data.phone.trim()) {
    if (!validatePhoneFormat(data.phone)) {
      errors.push('Phone: must be 7-15 digits');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate email format (simple regex)
 */
export function validateEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate phone format (digits only, 7-15 chars)
 */
export function validatePhoneFormat(phone: string): boolean {
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.length >= 7 && digitsOnly.length <= 15;
}

/**
 * Validate URL format
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate visibility level for Roles/Events feature (0-4)
 */
export function validateVisibilityLevel(level: any): boolean {
  return Number.isInteger(level) && level >= 0 && level <= 4;
}

/**
 * Validate role level for Roles/Events feature
 */
export function validateRoleLevel(role: string): boolean {
  return ['familiares', 'amigos', 'conocidos', 'publico'].includes(role);
}

/**
 * Validate advance hours for Roles/Events feature (0-360, i.e., 15 days)
 */
export function validateAdvanceHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= 0 && hours <= 360;
}

/**
 * Validate bonus hours for Roles/Events feature (0-500)
 */
export function validateBonusHours(hours: number): boolean {
  return Number.isInteger(hours) && hours >= 0 && hours <= 500;
}

/**
 * Validate invitation code format (alphanumeric, 10-32 chars)
 */
export function validateInvitationCode(code: string): boolean {
  return /^[a-zA-Z0-9]{10,32}$/.test(code);
}

/**
 * Validate a pickup-hours value (per-role window suggestion: 1-720 h)
 */
export function validatePickupHours(hours: any): boolean {
  return Number.isInteger(hours) && hours >= 1 && hours <= 720;
}

/**
 * Validate event creation input
 */
export function validateEventInput(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data.title?.trim() || data.title.length < 3) {
    errors.push('Event title: minimum 3 characters');
  }
  if (!data.available_from) {
    errors.push('Event available_from: required timestamp');
  }
  if (!data.pickup_deadline) {
    errors.push('Event pickup_deadline: required timestamp');
  }

  // Validate advance hours if provided
  if (data.familiares_advance_hours !== undefined && !validateAdvanceHours(data.familiares_advance_hours)) {
    errors.push('familiares_advance_hours: must be 0-360');
  }
  if (data.amigos_advance_hours !== undefined && !validateAdvanceHours(data.amigos_advance_hours)) {
    errors.push('amigos_advance_hours: must be 0-360');
  }
  if (data.conocidos_advance_hours !== undefined && !validateAdvanceHours(data.conocidos_advance_hours)) {
    errors.push('conocidos_advance_hours: must be 0-360');
  }

  // Validate share bonus if provided
  if (data.familiares_share_bonus !== undefined && !validateBonusHours(data.familiares_share_bonus)) {
    errors.push('familiares_share_bonus: must be 0-500');
  }
  if (data.amigos_share_bonus !== undefined && !validateBonusHours(data.amigos_share_bonus)) {
    errors.push('amigos_share_bonus: must be 0-500');
  }
  if (data.conocidos_share_bonus !== undefined && !validateBonusHours(data.conocidos_share_bonus)) {
    errors.push('conocidos_share_bonus: must be 0-500');
  }

  // Validate per-role pickup window suggestions if provided
  const pickupFields: Array<[string, string]> = [
    ['familiares_pickup_hours', 'familiares_pickup_hours'],
    ['amigos_pickup_hours', 'amigos_pickup_hours'],
    ['conocidos_pickup_hours', 'conocidos_pickup_hours'],
    ['publico_pickup_hours', 'publico_pickup_hours']
  ];
  for (const [key] of pickupFields) {
    if (data[key] !== undefined && data[key] !== null && !validatePickupHours(data[key])) {
      errors.push(`${key}: must be 1-720`);
    }
  }

  return { valid: errors.length === 0, errors };
}
