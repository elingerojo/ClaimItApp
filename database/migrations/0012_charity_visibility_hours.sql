-- ============================================================================
-- Migration 0012: visibilidad de objetos enviados a caridad para el visitante
-- ============================================================================
-- Agrega a la plantilla de agenda global (`event_config`, fila id=1) el campo:
--
--   charity_visibility_hours  INTEGER NOT NULL DEFAULT 72  (0..8760)
--
-- Semántica (acordada):
--   * Es el número de horas, contadas desde `items.charity_at`, durante las
--     cuales un objeto en fase `enviado_a_caridad` permanece VISIBLE en el
--     catálogo del visitante (GET /api/items).
--   * Pasado ese plazo, el objeto deja de mostrarse en el feed del visitante
--     (el listado admin /api/admin/items y la purga de PURGE_CLOSED_DAYS no se
--     ven afectados).
--   * 0 = ocultar de inmediato al enviarse a caridad.
--   * Default 72 horas = 3 días.
--
-- `event_config` nace en la migración 0004; el reset desde cero
-- (db-reset.js: init.sql + migraciones en orden) queda cubierto por esta
-- migración. init.sql (base schema) NO define event_config.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + CHECK en bloque DO.
--
-- Aplicar sobre una BD viva:
--   node scripts/run-migration.js database/migrations/0012_charity_visibility_hours.sql
-- ============================================================================

BEGIN;

ALTER TABLE event_config
  ADD COLUMN IF NOT EXISTS charity_visibility_hours INTEGER NOT NULL DEFAULT 72;

-- CHECK idempotente (PostgreSQL no soporta ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_config_charity_vis_hours_range'
  ) THEN
    ALTER TABLE event_config
      ADD CONSTRAINT event_config_charity_vis_hours_range
      CHECK (charity_visibility_hours BETWEEN 0 AND 8760); -- 0..365 días
  END IF;
END $$;

COMMIT;
