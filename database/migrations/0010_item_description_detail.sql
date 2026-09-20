-- ============================================================================
-- Migration 0010: detalle descriptivo del item (description_detail)
-- ============================================================================
-- Agrega a `items` el campo editorial "Detalle descriptivo": una descripción
-- ampliada que captura el ADMIN a mano. Es INDEPENDIENTE de `items.description`
-- (la descripción generada por IA): en SP1 solo cambió la ETIQUETA de UI a
-- "Descripción (IA)", el nombre de la columna `items.description` NO se toca.
--
-- Contrato (plan §2.3 y decisiones 2 y 3):
--   - `description_detail TEXT`, NULL-able, sin DEFAULT, sin NOT NULL y sin
--     CHECK: no hay longitud mínima (y ninguna cota en BD).
--   - `NULL` = "no proporcionado" ⇒ la UI del visitante NO renderiza bloque.
--   - La captura es 100% manual (nunca derivada, nunca IA).
--   - El PATCH debe distinguir `undefined` (no tocar) de `null` (limpiar a
--     NULL); nunca se persiste la cadena vacía (normalizada a NULL en la API).
--   - La única cota de longitud es de aplicación:
--     DESCRIPTION_DETAIL_MAX_LENGTH en shared/validators.ts.
--
-- Estrictamente aditivo: no renombra ni altera `items.description`, no toca
-- precios, multiplicadores, visibilidad, fases ni reglas de claim.
--
-- Idempotente: `ADD COLUMN IF NOT EXISTS`, segura de re-ejecutar. El reset desde
-- cero (db-reset.js: init.sql + migraciones en orden) converge al mismo schema
-- porque la columna está espejada en database/init.sql (CREATE TABLE items).
--
-- Aplicar sobre una BD viva (desde la raíz del repo):
--   node scripts/run-migration.js database/migrations/0010_item_description_detail.sql
-- ============================================================================

BEGIN;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS description_detail TEXT;

COMMIT;
