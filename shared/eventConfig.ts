/**
 * shared/eventConfig.ts
 *
 * Configuración global de agenda de eventos (fila única en `event_config`)
 * y derivación de las 4 fechas públicas a partir de una única fecha ancla:
 * la fecha de publicación (`published_at`). Se conserva tal cual (v2 no la
 * cambia).
 *
 * Además define el tipo de la MATRIZ DE CONFIANZA v2 (`trust_levels_settings`):
 * dos valores de adelanto DINÁMICO por rol (cero columnas por evento):
 *   - advance_pub_hours_default  → adelanta la VISIBILIDAD desde published_at
 *   - advance_disp_hours_default → adelanta el INICIO DE CLAIM desde available_from
 * + multiplicador_precio_default (precio por rol) y max_apartados_simultaneos.
 * Regla de consistencia "nunca se reclama sin ver": advance_disp <= advance_pub
 * (CHECK a nivel schema, migración 0004).
 */

import type { Role } from './types.js';

export const HOUR_MS = 60 * 60 * 1000;

/** Fila de la plantilla de agenda global (event_config id=1). */
export interface EventConfig {
  /** available_from = published_at + esto (horas tras publicar que abren las reservas). */
  open_after_publish_hours: number;
  /** claims_close_at = available_from + esto (horas de ventana de claims). */
  claims_window_hours: number;
  /** pickup_deadline = claims_close_at + esto (horas de ventana de recogida tras el corte). */
  closing_window_hours: number;
  /** Nota de recogida (texto informativo). */
  pickup_schedule_info: string | null;
}

/** Las 4 fechas públicas que se derivan desde la ancla de publicación. */
export interface DerivedEventSchedule {
  published_at: Date;
  available_from: Date;
  claims_close_at: Date;
  pickup_deadline: Date;
}

/**
 * Expande la fecha de publicación a las 4 fechas públicas del evento.
 * Usado por el frontend (prefill del form de crear) y por el backend
 * (createEvent) para no duplicar la lógica de agenda.
 */
export function deriveEventSchedule(
  cfg: Pick<
    EventConfig,
    'open_after_publish_hours' | 'claims_window_hours' | 'closing_window_hours'
  >,
  publishedAt: Date
): DerivedEventSchedule {
  const available_from = new Date(publishedAt.getTime() + cfg.open_after_publish_hours * HOUR_MS);
  const claims_close_at = new Date(available_from.getTime() + cfg.claims_window_hours * HOUR_MS);
  const pickup_deadline = new Date(claims_close_at.getTime() + cfg.closing_window_hours * HOUR_MS);
  return { published_at: publishedAt, available_from, claims_close_at, pickup_deadline };
}

/**
 * Fila de la MATRIZ DE CONFIANZA v2 por rol (trust_levels_settings).
 * `advance_pub_hours_default` adelanta la visibilidad desde published_at;
 * `advance_disp_hours_default` adelanta el inicio de claim desde available_from.
 * Invariante por rol: advance_disp_hours_default <= advance_pub_hours_default
 * (nunca se reclama sin ver).
 */
export interface RoleConfigRow {
  /** id de la matriz: familiares | amigos | conocidos | publico. */
  id: Role;
  /** Adelanto de VISIBILIDAD desde events.published_at (0..360 h). */
  advance_pub_hours_default: number;
  /** Adelanto de INICIO DE CLAIM desde events.available_from (0..360 h). */
  advance_disp_hours_default: number;
  /** Precio por rol (multiplicador 0..9.99). */
  multiplicador_precio_default: number;
  /** Límite de apartados simultáneos del rol (>= 0). */
  max_apartados_simultaneos: number;
  /** Audit: cuándo se actualizó la matriz. */
  updated_at?: string;
}

/** Rango válido de horas de adelanto en la matriz (0..360 = máx 15 días). */
export const ADVANCE_HOURS_MIN = 0;
export const ADVANCE_HOURS_MAX = 360;
