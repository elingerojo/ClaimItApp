-- ============================================================================
-- Migration 0007: análisis de precio de mercado por código de barras
-- ============================================================================
-- Agrega a `items` las columnas del análisis de mercado que se obtiene durante
-- la CAPTURA: cuando la consulta a Gemini detecta un código UPC/EAN/ISBN/ASIN
-- (barcode / barcode_type), el backend consulta UPCitemdb y calcula min/max/avg
-- de las ofertas. El admin revisa esos valores antes de guardar; al persistir el
-- item se escriben estas columnas (NULL cuando no hay análisis).
--
-- Columnas:
--   - barcode             VARCHAR(40)  -> código leído (UPC/EAN/ISBN/ASIN) o NULL.
--   - barcode_type        VARCHAR(10)  -> 'UPC' | 'EAN' | 'ISBN' | 'ASIN' (CHECK).
--   - market_currency     CHAR(3)      -> moneda de la fuente de ofertas (p. ej. USD).
--   - market_min_price    NUMERIC(10,2)-> oferta más baja.
--   - market_max_price    NUMERIC(10,2)-> oferta más alta.
--   - market_avg_price    NUMERIC(10,2)-> promedio de las ofertas válidas.
--   - market_offers_count INTEGER      -> nº de ofertas usadas para el cálculo.
--   - market_analyzed_at  TIMESTAMPTZ  -> cuándo se calculó el análisis.
--
-- Los precios de mercado son INFORMATIVOS: no participan en el cálculo de
-- precioVisible (base × multiplicador) que sigue gobernando items.precio_base_costo.
--
-- En el reset desde cero (db-reset.js) init.sql ya define estas columnas, por lo
-- que esta migración es un no-op en ese flujo. Aplicar sobre una BD viva:
--   node scripts/run-migration.js database/migrations/0007_item_market_price_analysis.sql
-- ============================================================================

BEGIN;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(40),
  ADD COLUMN IF NOT EXISTS barcode_type VARCHAR(10),
  ADD COLUMN IF NOT EXISTS market_currency CHAR(3),
  ADD COLUMN IF NOT EXISTS market_min_price NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS market_max_price NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS market_avg_price NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS market_offers_count INTEGER,
  ADD COLUMN IF NOT EXISTS market_analyzed_at TIMESTAMPTZ;

-- CHECK idempotente (PostgreSQL no soporta ADD CONSTRAINT IF NOT EXISTS):
-- limita barcode_type a los tipos soportados cuando la columna ya existía.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'items_barcode_type_check'
  ) THEN
    ALTER TABLE items ADD CONSTRAINT items_barcode_type_check
      CHECK (barcode_type IS NULL OR barcode_type IN ('UPC', 'EAN', 'ISBN', 'ASIN'));
  END IF;
END $$;

COMMIT;
