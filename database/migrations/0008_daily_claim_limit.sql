-- ============================================================================
-- Migration 0008: límite DIARIO de apartados por rol
-- ============================================================================
-- Agrega a la matriz de confianza (`trust_levels_settings`) un segundo límite
-- de apartados, además del simultáneo (`max_apartados_simultaneos`):
--
--   - max_apartados_diarios  INTEGER NOT NULL DEFAULT 0  (>= 0)
--
-- Semántica (acordada):
--   * Cuenta por USUARIO, GLOBAL para el día calendario en UTC-6
--     (America/Mexico_City), cruzando todos los eventos.
--   * Cuenta las claims del usuario creadas dentro del día que NO estén en
--     `claim_state = 'cancelado_voluntario'`; expirios, voids y caridad SÍ
--     siguen contando (consumen cupo).
--   * Liberar voluntariamente ("Ya no lo quiero") devuelve el cupo del día.
--   * La ventana libre NO está sujeta al límite diario.
--   * Aviso suave cuando `remaining <= ceil(0.25 * max_apartados_diarios)` y
--     rechazo con código `daily_limit_exceeded` al agotarse.
--
-- `trust_levels_settings` nace en la migración 0004, por lo que el reset desde
-- cero (db-reset.js: init.sql + todas las migraciones en orden) queda cubierto
-- con esta migración; init.sql (base schema) NO define la matriz de confianza.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + CHECK en bloque DO + seed que solo
-- aplica si la columna acaba de agregarse (todos los valores en 0).
--
-- Aplicar sobre una BD viva:
--   node scripts/run-migration.js database/migrations/0008_daily_claim_limit.sql
-- ============================================================================

BEGIN;

ALTER TABLE trust_levels_settings
  ADD COLUMN IF NOT EXISTS max_apartados_diarios INTEGER NOT NULL DEFAULT 0;

-- CHECK idempotente (PostgreSQL no soporta ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trust_max_apartados_diarios_nonneg'
  ) THEN
    ALTER TABLE trust_levels_settings
      ADD CONSTRAINT trust_max_apartados_diarios_nonneg
      CHECK (max_apartados_diarios >= 0);
  END IF;
END $$;

-- Seed por rol (familiares 5, amigos 4, conocidos 3, publico 2). Solo cuando la
-- columna recién se agregó (todas las filas en 0), para no clobber la config
-- que el admin ya haya guardado en re-ejecuciones de la migración.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM trust_levels_settings WHERE max_apartados_diarios <> 0
  ) THEN
    UPDATE trust_levels_settings SET
      max_apartados_diarios = CASE id
        WHEN 'familiares' THEN 5
        WHEN 'amigos'     THEN 4
        WHEN 'conocidos'  THEN 3
        WHEN 'publico'    THEN 2
        ELSE max_apartados_diarios
      END,
      updated_at = NOW();
  END IF;
END $$;

COMMIT;
