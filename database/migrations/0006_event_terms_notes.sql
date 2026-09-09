-- ============================================================================
-- Migration 0006: notas markdown de términos y condiciones por evento
-- ============================================================================
-- Agrega dos columnas informativas a `events`:
--   - times_notes      (TEXT): nota markdown de tiempos.
--   - conditions_notes (TEXT): nota markdown de condiciones (términos y
--     condiciones).
-- Semánticamente son SOLO notas para definir términos y condiciones: nunca
-- participan en cálculos (mismo rol que pickup_schedule_info). Se renderizan
-- (markdown) al final de las pestañas Tiempos/Condiciones del detalle de cada
-- objeto.
--
-- En el reset desde cero (db-reset.js) init.sql ya define estas columnas, por
-- lo que esta migración es un no-op en ese flujo. Aplicar sobre una BD viva:
--   node scripts/run-migration.js database/migrations/0006_event_terms_notes.sql
-- ============================================================================

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS times_notes TEXT,
  ADD COLUMN IF NOT EXISTS conditions_notes TEXT;

COMMIT;
