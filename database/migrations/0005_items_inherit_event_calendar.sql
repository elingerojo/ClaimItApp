-- ============================================================================
-- Migration 0005 (v2): items heredan SIEMPRE el calendario del evento
-- ============================================================================
-- Regla de diseño "todos los items de un evento comparten SIEMPRE el calendario
-- del evento" (plan plans/items-inherit-event-calendar.md):
--   - Se eliminan items.visible_at e items.available_from: la visibilidad y la
--     apertura de "Lo quiero" se derivan en tiempo de lectura de
--     events.published_at / events.available_from (cálculo por rol en backend).
--     El item ya no puede desviarse del calendario de su evento.
--   - Se elimina items.nivel_acceso_minimo: columna redundante y muerta
--     (misma retícula que items.visibility_level; nunca se lee en lógica).
-- Los índices idx_items_visible_at / idx_items_available_from se eliminan en
-- cascada con las columnas.
--
-- En el reset desde cero (db-reset.js) init.sql ya no define estas columnas,
-- por lo que esta migración es un no-op en ese flujo. Aplicar sobre una BD viva
-- con columnas existentes mediante:
--   node scripts/run-migration.js database/migrations/0005_items_inherit_event_calendar.sql
-- ============================================================================

BEGIN;

ALTER TABLE items
  DROP COLUMN IF EXISTS visible_at,
  DROP COLUMN IF EXISTS available_from,
  DROP COLUMN IF EXISTS nivel_acceso_minimo;

COMMIT;
