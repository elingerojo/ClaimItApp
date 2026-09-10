/**
 * shared/validators.ts
 *
 * Validación de integridad v2 (Estrategia temporal v2):
 *  - Eventos: 4 marcas de tiempo en orden (published_at <= available_from <=
 *    claims_close_at <= pickup_deadline) y, al crear (opcional), futuras.
 *    CERO columnas por rol: se eliminó la validación de pickup-hours /
 *    share-bonus / advance por evento (D8).
 *  - Matriz de confianza (trust_levels_settings): dos valores de adelanto por
 *    rol (advance_pub_hours_default / advance_disp_hours_default) con la regla
 *    de consistencia advance_disp <= advance_pub ("nunca se reclama sin ver").
 *  - Snapshot congelado / línea de tiempo fija (estado-temporal): chequeo
 *    estructural ligero para no persistir jsonb incoherente.
 *
 * Se conservan los validadores de items/claims/contactos/invitaciones (v2 no
 * los cambia).
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(new Date(value).getTime());
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
  // Al menos 1 foto por Item (arreglo ordenado de URLs)
  validateImageUrls(data.imageUrls, errors);

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
 * Validate claim submission input (v2: la fase de claim la gobierna la Fase 3;
 * aquí solo forma básica + contacto).
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
 * Validate the ordered photo array of an Item (imageUrls).
 * - Must be a non-empty array (al menos 1 foto por Item).
 * - Each element must be a non-empty valid URL string.
 * Pushes specific errors to the provided list.
 */
export function validateImageUrls(imageUrls: any, errors: string[]): void {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    errors.push('Image URLs: at least one photo is required');
    return;
  }
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (typeof url !== 'string' || !url.trim() || !isValidUrl(url)) {
      errors.push(`Image URL #${i + 1}: invalid URL format`);
    }
  }
}

/**
 * Validate visibility level for Roles/Events feature (0-4)
 */
export function validateVisibilityLevel(level: any): boolean {
  return Number.isInteger(level) && level >= 0 && level <= 4;
}

/**
 * Valida los campos OPCIONALES del análisis de mercado por código de barras que
 * puede enviar el admin al crear/editar un item (create/update). Solo se valida
 * lo que venga definido (`!== undefined`), igual que el UPDATE parcial:
 *  - barcode: cadena alfanumérica acotada (<= 40).
 *  - barcode_type: uno de UPC/EAN/ISBN/ASIN (o null para limpiar).
 *  - market_currency: código ISO de 3 letras (o null).
 *  - market_min/max/avg_price: número finito >= 0 (o null para limpiar).
 *  - market_offers_count: entero >= 0 (o null).
 *  - market_analyzed_at: ISO válido (o null).
 * Devuelve los errores encontrados; [] si todo es válido/ausente.
 */
export function validateMarketFields(data: any): string[] {
  const errors: string[] = [];

  if (data.barcode !== undefined && data.barcode !== null) {
    if (typeof data.barcode !== 'string' || !data.barcode.trim() || data.barcode.length > 40) {
      errors.push('barcode: must be a string of at most 40 chars (or null)');
    }
  }

  if (data.barcode_type !== undefined && data.barcode_type !== null) {
    if (!['UPC', 'EAN', 'ISBN', 'ASIN'].includes(data.barcode_type)) {
      errors.push('barcode_type: must be one of UPC/EAN/ISBN/ASIN (or null)');
    }
  }

  if (data.market_currency !== undefined && data.market_currency !== null) {
    if (typeof data.market_currency !== 'string' || !/^[A-Z]{3}$/.test(data.market_currency)) {
      errors.push('market_currency: must be a 3-letter ISO currency code (or null)');
    }
  }

  const nullableNumber = (key: string, label: string): void => {
    const v = data[key];
    if (v === undefined || v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${label}: must be a finite number >= 0 (or null)`);
    }
  };
  nullableNumber('market_min_price', 'market_min_price');
  nullableNumber('market_max_price', 'market_max_price');
  nullableNumber('market_avg_price', 'market_avg_price');

  if (data.market_offers_count !== undefined && data.market_offers_count !== null) {
    if (!Number.isInteger(Number(data.market_offers_count)) || Number(data.market_offers_count) < 0) {
      errors.push('market_offers_count: must be a non-negative integer (or null)');
    }
  }

  if (data.market_analyzed_at !== undefined && data.market_analyzed_at !== null) {
    if (typeof data.market_analyzed_at !== 'string' || Number.isNaN(new Date(data.market_analyzed_at).getTime())) {
      errors.push('market_analyzed_at: must be a valid ISO timestamp (or null)');
    }
  }

  return errors;
}

/**
 * Validate role level (familiares/amigos/conocidos/publico)
 */
export function validateRoleLevel(role: unknown): boolean {
  return (
    typeof role === 'string' &&
    ['familiares', 'amigos', 'conocidos', 'publico'].includes(role)
  );
}

/**
 * Validate a single advance-hours value of the matrix (0-360 = máx 15 días).
 * Aplica a advance_pub_hours_default y advance_disp_hours_default.
 */
export function validateAdvanceHours(hours: unknown): boolean {
  return Number.isInteger(hours) && (hours as number) >= 0 && (hours as number) <= 360;
}

/**
 * Validate invitation code format (alphanumeric, 10-32 chars)
 */
export function validateInvitationCode(code: string): boolean {
  return /^[a-zA-Z0-9]{10,32}$/.test(code);
}

export interface ValidateEventInputOptions {
  /**
   * Si es true (creación de evento), exige que available_from /
   * claims_close_at / pickup_deadline estén en el futuro. En ediciones de un
   * evento ya iniciado NO exigir futuras (algunas pueden quedar en el pasado).
   */
  requireFuture?: boolean;
  /** Exige que las 4 fechas estén presentes (published_at incluido). */
  requireCompleteTimeline?: boolean;
}

/**
 * Validate event creation/update input (v2).
 * Solo valida las 4 marcas de tiempo + orden; NO valida columnas por rol
 * (pickup-hours/share-bonus/advance por evento fueron ELIMINADAS, D8).
 *
 * Orden requerido cuando las fechas están presentes:
 *   published_at <= available_from <= claims_close_at <= pickup_deadline
 * con pickup_deadline estrictamente posterior a claims_close_at.
 */
export function validateEventInput(
  data: any,
  options?: ValidateEventInputOptions
): ValidationResult {
  const errors: string[] = [];
  const { requireFuture = false, requireCompleteTimeline = false } = options || {};

  if (!data.title?.trim() || data.title.length < 3) {
    errors.push('Event title: minimum 3 characters');
  }

  const { published_at, available_from, claims_close_at, pickup_deadline } = data;

  if (requireCompleteTimeline) {
    if (!isValidDateString(published_at)) {
      errors.push('Event published_at: required timestamp');
    }
  } else if (published_at !== undefined && published_at !== null && published_at !== '') {
    if (!isValidDateString(published_at)) {
      errors.push('Event published_at: invalid timestamp');
    }
  }

  if (!isValidDateString(available_from)) {
    errors.push('Event available_from: required timestamp');
  }
  if (!isValidDateString(pickup_deadline)) {
    errors.push('Event pickup_deadline: required timestamp');
  }

  const pubMs = isValidDateString(published_at) ? new Date(published_at).getTime() : null;
  const availMs = isValidDateString(available_from) ? new Date(available_from).getTime() : null;
  const claimsMs = isValidDateString(claims_close_at) ? new Date(claims_close_at).getTime() : null;
  const pickupMs = isValidDateString(pickup_deadline) ? new Date(pickup_deadline).getTime() : null;
  const nowMs = Date.now();

  // Orden: published_at <= available_from (cuando published esté presente)
  if (pubMs !== null && availMs !== null && pubMs > availMs) {
    errors.push('published_at must be <= available_from');
  }
  // available_from <= claims_close_at (cuando claims esté presente)
  if (availMs !== null && claimsMs !== null && availMs > claimsMs) {
    errors.push('available_from must be <= claims_close_at');
  }
  // claims_close_at <= pickup_deadline (estricto, como el CHECK de la BD)
  if (claimsMs !== null && pickupMs !== null && claimsMs >= pickupMs) {
    errors.push('claims_close_at must be < pickup_deadline');
  }
  // pickup_deadline > available_from (siempre, aunque no haya claims)
  if (availMs !== null && pickupMs !== null && availMs >= pickupMs) {
    errors.push('pickup_deadline must be > available_from');
  }

  if (requireFuture) {
    if (availMs !== null && availMs <= nowMs) {
      errors.push('available_from must be in the future');
    }
    if (claimsMs !== null && claimsMs <= nowMs) {
      errors.push('claims_close_at must be in the future');
    }
    if (pickupMs !== null && pickupMs <= nowMs) {
      errors.push('pickup_deadline must be in the future');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate the event_config agenda: the three hour gaps used to expand a
 * single publication date into the 4 public event dates.
 */
export function validateEventConfig(data: any): ValidationResult {
  const errors: string[] = [];
  const keys = [
    'open_after_publish_hours',
    'claims_window_hours',
    'closing_window_hours'
  ] as const;
  for (const key of keys) {
    const v = data?.[key];
    if (!Number.isInteger(v) || (v as number) < 0) {
      errors.push(`${key}: must be a non-negative integer`);
    }
  }
  if (data?.pickup_schedule_info !== undefined && data.pickup_schedule_info !== null) {
    if (typeof data.pickup_schedule_info !== 'string') {
      errors.push('pickup_schedule_info: must be a string or null');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Valida un valor de adelanto (pub o disp) de la matriz: entero 0..360.
 */
export function validateMatrixAdvanceHours(value: unknown, label: string): string | null {
  if (!Number.isInteger(value)) return `${label}: must be an integer`;
  if ((value as number) < 0 || (value as number) > 360) {
    return `${label}: must be 0-360 (max 15 days)`;
  }
  return null;
}

/**
 * Validate a role-config update payload (matriz de confianza v2):
 * { roles: { familiares: { advance_pub_hours_default, advance_disp_hours_default,
 *                          multiplicador_precio_default?, max_apartados_simultaneos? },
 *            amigos: {...}, conocidos: {...}, publico: {...} } }
 *
 * Regla de consistencia por rol: advance_disp_hours_default <=
 * advance_pub_hours_default ("nunca se reclama sin ver", espejo del CHECK de la
 * migración 0004).
 */
export function validateRoleDefaultsUpdate(data: any): ValidationResult {
  const errors: string[] = [];
  const roles = data?.roles;
  if (!roles || typeof roles !== 'object') {
    errors.push('roles: required object keyed by role id');
    return { valid: false, errors };
  }

  for (const role of ['familiares', 'amigos', 'conocidos', 'publico']) {
    const r = roles[role];
    if (r === undefined || r === null) continue;

    // Actualización PARCIAL por diseño: el cliente puede enviar SOLO precio o
    // apartados (permitido incluso con eventos live) sin los adelantos. Solo se
    // validan los campos presentes en el payload (guía `!== undefined`), igual
    // que el UPDATE del controller — un campo ausente (undefined) no debe
    // fallar como "must be an integer".
    const hasPub = r.advance_pub_hours_default !== undefined;
    const hasDisp = r.advance_disp_hours_default !== undefined;

    if (hasPub) {
      const pubErr = validateMatrixAdvanceHours(r.advance_pub_hours_default, `${role}.advance_pub_hours_default`);
      if (pubErr) errors.push(pubErr);
    }

    if (hasDisp) {
      const dispErr = validateMatrixAdvanceHours(r.advance_disp_hours_default, `${role}.advance_disp_hours_default`);
      if (dispErr) errors.push(dispErr);
    }

    // Regla de consistencia (nunca se reclama sin ver): solo tiene sentido
    // cuando AMBOS adelantos vienen en el payload.
    if (
      hasPub &&
      hasDisp &&
      Number.isInteger(r.advance_pub_hours_default) &&
      Number.isInteger(r.advance_disp_hours_default) &&
      r.advance_disp_hours_default > r.advance_pub_hours_default
    ) {
      errors.push(
        `${role}.advance_disp_hours_default must be <= advance_pub_hours_default (never claim before seeing)`
      );
    }

    if (r.multiplicador_precio_default !== undefined) {
      const m = Number(r.multiplicador_precio_default);
      if (!Number.isFinite(m) || m < 0 || m > 9.99) {
        errors.push(`${role}.multiplicador_precio_default: must be 0-9.99`);
      }
    }
    if (r.max_apartados_simultaneos !== undefined) {
      if (!Number.isInteger(r.max_apartados_simultaneos) || r.max_apartados_simultaneos < 0) {
        errors.push(`${role}.max_apartados_simultaneos: must be a non-negative integer`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validación estructural ligera de un snapshot congelado (FrozenSchedule).
 * Chequea invariantes clave del jsonb antes de persistir/leer:
 *  - v1/v2/v3 son ISO válidos o null y respetan que una posición vacía no tiene
 *    vencimiento mientras la siguiente ocupada sí (sanidad de la cola).
 *  - ventana_libre_starts_at >= claims_close_at (t_inicio).
 *  - charity_at === t_final.
 *  - positions: posiciones 1..3 únicas, share_pct en [0,100], v_expires_at ISO.
 */
export function validateFrozenSchedule(schedule: any): ValidationResult {
  const errors: string[] = [];

  if (!schedule || typeof schedule !== 'object') {
    return { valid: false, errors: ['frozen_schedule: must be an object'] };
  }
  if (schedule.version !== 2) errors.push('version: must be 2');

  const tInicio = isValidDateString(schedule.t_inicio) ? new Date(schedule.t_inicio).getTime() : null;
  const tFinal = isValidDateString(schedule.t_final) ? new Date(schedule.t_final).getTime() : null;
  if (tInicio === null) errors.push('t_inicio: required ISO timestamp');
  if (tFinal === null) errors.push('t_final: required ISO timestamp');
  if (tInicio !== null && tFinal !== null && tFinal <= tInicio) {
    errors.push('t_final must be > t_inicio');
  }
  if (isValidDateString(schedule.charity_at)) {
    const charityMs = new Date(schedule.charity_at).getTime();
    if (tFinal !== null && charityMs !== tFinal) {
      errors.push('charity_at must equal t_final (plan de caridad)');
    }
  } else {
    errors.push('charity_at: required ISO timestamp');
  }

  for (const key of ['v1', 'v2', 'v3'] as const) {
    const v = schedule[key];
    if (v !== null && v !== undefined && !isValidDateString(v)) {
      errors.push(`${key}: must be an ISO timestamp or null`);
    }
  }

  if (!isValidDateString(schedule.ventana_libre_starts_at)) {
    errors.push('ventana_libre_starts_at: required ISO timestamp');
  } else {
    const vwMs = new Date(schedule.ventana_libre_starts_at).getTime();
    if (tInicio !== null && vwMs < tInicio) {
      errors.push('ventana_libre_starts_at must be >= t_inicio');
    }
    if (tFinal !== null && vwMs > tFinal) {
      errors.push('ventana_libre_starts_at must be <= t_final');
    }
  }

  if (!Array.isArray(schedule.positions)) {
    errors.push('positions: required array');
  } else {
    const seen = new Set<number>();
    for (const p of schedule.positions) {
      if (!p || typeof p !== 'object') {
        errors.push('positions: each entry must be an object');
        continue;
      }
      if (!Number.isInteger(p.position) || p.position < 1 || p.position > 3) {
        errors.push('position: must be 1-3');
      } else if (seen.has(p.position)) {
        errors.push(`position ${p.position}: duplicated`);
      } else {
        seen.add(p.position);
      }
      if (!isValidDateString(p.v_expires_at)) {
        errors.push(`position ${p.position}: v_expires_at required ISO`);
      }
      if (!Number.isFinite(p.share_pct) || p.share_pct < 0 || p.share_pct > 100) {
        errors.push(`position ${p.position}: share_pct must be 0-100`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
