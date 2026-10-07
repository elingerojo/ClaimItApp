-- ============================================================================
-- Migration 0013: campo único de visibilidad de objetos TERMINALES
-- ============================================================================
-- Consolida un solo umbral para OCULTAR del catálogo del visitante tanto los
-- objetos `entregado` como los `enviado_a_caridad`:
--
--   terminal_visibility_hours  INTEGER NOT NULL DEFAULT 72  (0..8760)
--
-- Semántica (acordada):
--   * Horas que un objeto TERMINAL permanece VISIBLE en el catálogo del
--     visitante (GET /api/items) contadas desde su cierre:
--       - `entregado`          -> desde `items.delivered_at`
--       - `enviado_a_caridad`  -> desde `items.charity_at` (fallback al
--                                 `pickup_deadline` del evento)
--   * Pasado ese plazo, el objeto deja de mostrarse en el feed del visitante.
--     El listado admin (/api/admin/items) y la purga (PURGE_CLOSED_DAYS) no se
--     ven afectados.
--   * 0 = ocultar de inmediato. Default 72 horas = 3 días.
--
-- Reemplaza al campo `charity_visibility_hours` introducido en la migración
-- 0012 (que queda como histórico): se copia su valor y se elimina la columna
-- anterior.
--
-- `event_config` nace en la migración 0004; el reset desde cero
-- (db-reset.js: init.sql + migraciones en orden) queda cubierto por 0012 + 0013.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + copy condicional + CHECK en bloque DO
-- + DROP ... IF EXISTS.
--
-- Aplicar sobre una BD viva:
--   node scripts/run-migration.js database/migrations/0013_terminal_visibility_hours.sql
-- ============================================================================

BEGIN;

ALTER TABLE event_config
  ADD COLUMN IF NOT EXISTS terminal_visibility_hours INTEGER NOT NULL DEFAULT 72;

-- Migrar el valor previo si la columna vieja aún existe (DBs ya migradas con 0012).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'event_config' AND column_name = 'charity_visibility_hours'
  ) THEN
    EXECUTE 'UPDATE event_config SET terminal_visibility_hours = charity_visibility_hours';
  END IF;
END $$;

-- CHECK idempotente con el nombre definitivo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_config_terminal_vis_hours_range'
  ) THEN
    ALTER TABLE event_config
      ADD CONSTRAINT event_config_terminal_vis_hours_range
      CHECK (terminal_visibility_hours BETWEEN 0 AND 8760); -- 0..365 días
  END IF;
END $$;

-- Retirar la columna/constraint anteriores.
ALTER TABLE event_config DROP CONSTRAINT IF EXISTS event_config_charity_vis_hours_range;
ALTER TABLE event_config DROP COLUMN IF EXISTS charity_visibility_hours;

COMMIT;
