-- ============================================================================
-- Migration 0001 (v2): items.delivered_claim_id FK forense -> claims
-- ============================================================================
-- Rompe el ciclo items↔claims: init.sql crea items.delivered_claim_id como UUID
-- sin FK (claims aún no existe en ese punto). Aquí, con `claims` ya creada, se
-- añade la restricción que identifica al claim cuyo retiro llevó el artículo a
-- phase='entregado' (titular del turno o captura de ventana libre).
--
-- ON DELETE SET NULL: si el claim se purga, el registro forense del item se
-- conserva (solo se pierde la referencia).
-- Aplicar automáticamente con db-reset.js (orden léxico) o manualmente con:
--   node scripts/run-migration.js database/migrations/0001_item_delivery_forensics.sql
-- ============================================================================

BEGIN;

ALTER TABLE items
  DROP CONSTRAINT IF EXISTS items_delivered_claim_fk;

ALTER TABLE items
  ADD CONSTRAINT items_delivered_claim_fk
  FOREIGN KEY (delivered_claim_id) REFERENCES claims (id) ON DELETE SET NULL;

COMMIT;
