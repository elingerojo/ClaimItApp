/**
 * shared/eventConfig.ts
 *
 * Configuración global de agenda de eventos (fila única en `event_config`)
 * y derivación de las 4 fechas públicas a partir de una única fecha ancla:
 * la fecha de publicación (`published_at`).
 *
 * La plantilla `event_config` NO contiene ventajas por rol: esas viven en
 * `trust_levels_settings` (matriz) y se congelan sobre cada evento al crearlo.
 */

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

/** Rollos editables en la matriz por rol (advance/bonus/recogida). */
export interface RoleConfigRow {
  /** id de la matriz: familiares | amigos | conocidos | publico. */
  id: string;
  advance_hours_default: number;
  share_bonus_default: number;
  intervalo_recoleccion_horas_default: number;
}
