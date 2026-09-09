-- ============================================================================
-- Migration 0004 (v2): matriz de confianza (por rol) + plantilla de agenda
-- ============================================================================
-- CONTRATO v2 (D3/D4):
--   * trust_levels_settings guarda por rol DOS valores de adelanto DINÁMICO
--     (cero columnas por evento):
--       - advance_pub_hours_default  -> adelanta la VISIBILIDAD desde published_at
--       - advance_disp_hours_default -> adelanta el INICIO DE CLAIM desde available_from
--     + multiplicador_precio_default (precio por rol) y max_apartados_simultaneos
--     (límite de apartados). Sin share_bonus_default ni intervalo_recoleccion_horas_default.
--
--   * Regla de consistencia "nunca se reclama sin ver": para cada rol el instante
--     de visibilidad (P_pub − adv_pub) debe ser <= al instante de inicio de claim
--     (P_disp − adv_disp). Como P_disp = P_pub + G con G >= 0 (plantilla de
--     agenda), la condición suficiente y necesaria para TODO evento es
--     advance_disp_hours_default <= advance_pub_hours_default. Se aplica como
--     CHECK en la matriz (guarda a nivel schema).
--
--   * Los cambios de la matriz SOLO aplican a eventos futuros/no iniciados. No
--     hay columna por evento: la guarda de negocio (rechazar edición mientras
--     exista un evento scheduled/active) pertenece a la fase de controllers y
--     queda documentada en plans/estrategia-temporal-v2.md (§4.1 y §6). La
--     columna updated_at permite auditar cuándo cambió la matriz.
--
--   * event_config (id=1): plantilla de agenda global para derivar las 4 fechas
--     desde la ancla de publicación (published_at) cuando el form no las trae.
--
-- Aplicar automáticamente con db-reset.js (orden léxico) o manualmente con:
--   node scripts/run-migration.js database/migrations/0004_trust_matrix_and_agenda.sql
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Matriz de confianza por rol (dinámico puro)
-- ----------------------------------------------------------------------------
CREATE TABLE trust_levels_settings (
  id VARCHAR(20) PRIMARY KEY
    CHECK (id IN ('familiares', 'amigos', 'conocidos', 'publico')),
  advance_pub_hours_default INTEGER NOT NULL DEFAULT 0
    CHECK (advance_pub_hours_default BETWEEN 0 AND 360),   -- máx 15 días
  advance_disp_hours_default INTEGER NOT NULL DEFAULT 0
    CHECK (advance_disp_hours_default BETWEEN 0 AND 360),
  multiplicador_precio_default NUMERIC(4, 2) NOT NULL,
  max_apartados_simultaneos INTEGER NOT NULL CHECK (max_apartados_simultaneos >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- "Nunca se reclama sin ver": visibilidad antes que el inicio de claim para
  -- cualquier evento (ver nota de cabecera).
  CONSTRAINT trust_visibility_before_claim
    CHECK (advance_disp_hours_default <= advance_pub_hours_default)
);

-- Seed por defecto (valores de arranque; editables por el admin en fase de
-- controllers — la lectura de visibilidad/claim es dinámica).
INSERT INTO trust_levels_settings
  (id, advance_pub_hours_default, advance_disp_hours_default,
   multiplicador_precio_default, max_apartados_simultaneos)
VALUES
  ('familiares', 72, 24, 0.70, 15),
  ('amigos',     24,  8, 0.85,  5),
  ('conocidos',   0,  0, 0.95,  2),
  ('publico',     0,  0, 1.00,  1)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Plantilla de agenda global (1 fila, id=1)
-- ----------------------------------------------------------------------------
CREATE TABLE event_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- available_from = published_at + open_after_publish_hours
  open_after_publish_hours INTEGER NOT NULL DEFAULT 24,
  -- claims_close_at = available_from + claims_window_hours
  claims_window_hours INTEGER NOT NULL DEFAULT 72,
  -- pickup_deadline = claims_close_at + closing_window_hours
  closing_window_hours INTEGER NOT NULL DEFAULT 48,
  -- Nota de recogida (texto informativo; nunca se usa en cálculos).
  pickup_schedule_info TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO event_config (id, pickup_schedule_info)
VALUES (1, 'Entrega en sitio; el horario de recolección se coordina con el anfitrión.')
ON CONFLICT (id) DO NOTHING;

COMMIT;
