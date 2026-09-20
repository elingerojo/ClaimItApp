-- ============================================================================
-- Migration 0011: estado físico del item (condition_*)
-- ============================================================================
-- Agrega a `items` los 5 campos del "estado físico": información 100% manual que
-- captura el ADMIN (nunca derivada, nunca sugerida por IA) y SOLO informativa:
-- no altera precio, multiplicadores, visibilidad, fases ni reglas de claim.
--
-- Todos son NULL-ables y sin DEFAULT: NULL = "no proporcionado" ⇒ la UI del
-- visitante NO debe renderizar el campo.
--
-- Catálogo ORDENADO de `condition_grade` (mejor → peor, rank 7→1), tal como lo
-- documenta el plan §2.1. El orden de render del select y las etiquetas ES viven
-- en `shared/itemCondition.ts` (fuente única del dominio):
--   rank 7  nuevo_sellado     -> nuevo + original_sellado + todos + perfecto
--   rank 6  como_nuevo        -> usado + original_abierto + todos + como_nuevo
--   rank 5  excelente         -> usado + envuelto_sin_caja + todos + normal
--   rank 4  bueno             -> usado + sin_empaque + algunos + normal
--   rank 3  regular           -> desgaste visible; funciona normal
--   rank 2  con_fallas        -> funcionamiento parcial o faltantes importantes
--   rank 1  para_refacciones  -> no_funciona
--
-- Vocabularios de los calificadores (mismo patrón VARCHAR(20) + CHECK que
-- `barcode_type` en 0007, para poder agregar valores sin ALTER TYPE):
--   condition_packaging     -> original_sellado | original_abierto | envuelto_sin_caja | sin_empaque
--   condition_accessories   -> todos | algunos | sin
--   condition_usage         -> nuevo | usado
--   condition_functionality -> perfecto | como_nuevo | normal | se_desconoce | no_funciona
-- Nota (plan §2.2): el identificador interno de funcionamiento es `perfecto` y NO
-- el literal '100' propuesto inicialmente (un id numérico en VARCHAR + CHECK
-- envejece mal); su etiqueta de UI sigue siendo "100% (perfecto)".
--
-- Idempotente y re-ejecutable: `ADD COLUMN IF NOT EXISTS` + CHECKs dentro de un
-- guard `DO $$ ... pg_constraint` (PostgreSQL no soporta ADD CONSTRAINT IF NOT
-- EXISTS). Nombre de cada constraint = `items_condition_<columna>_check`, el
-- mismo que PostgreSQL genera para el CHECK en línea de `database/init.sql`, así
-- que el reset desde cero (db-reset.js: init.sql + migraciones en orden) converge
-- al mismo schema y esta migración es un no-op en ese flujo.
--
-- Estrictamente aditivo: no renombra ni altera columnas existentes.
--
-- Aplicar sobre una BD viva (desde la raíz del repo) — PENDIENTE, no se aplicó:
--   node scripts/run-migration.js database/migrations/0011_item_physical_condition.sql
-- ============================================================================

BEGIN;

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS condition_grade VARCHAR(20),
  ADD COLUMN IF NOT EXISTS condition_packaging VARCHAR(20),
  ADD COLUMN IF NOT EXISTS condition_accessories VARCHAR(20),
  ADD COLUMN IF NOT EXISTS condition_usage VARCHAR(20),
  ADD COLUMN IF NOT EXISTS condition_functionality VARCHAR(20);

-- CHECKs idempotentes (PostgreSQL no soporta ADD CONSTRAINT IF NOT EXISTS):
-- limitan cada vocabulario cuando la columna ya existía. `IS NULL OR` mantiene
-- válido el caso "no proporcionado".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_condition_grade_check'
  ) THEN
    ALTER TABLE items ADD CONSTRAINT items_condition_grade_check
      CHECK (condition_grade IS NULL OR condition_grade IN (
        'nuevo_sellado', 'como_nuevo', 'excelente', 'bueno',
        'regular', 'con_fallas', 'para_refacciones'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_condition_packaging_check'
  ) THEN
    ALTER TABLE items ADD CONSTRAINT items_condition_packaging_check
      CHECK (condition_packaging IS NULL OR condition_packaging IN (
        'original_sellado', 'original_abierto', 'envuelto_sin_caja', 'sin_empaque'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_condition_accessories_check'
  ) THEN
    ALTER TABLE items ADD CONSTRAINT items_condition_accessories_check
      CHECK (condition_accessories IS NULL OR condition_accessories IN (
        'todos', 'algunos', 'sin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_condition_usage_check'
  ) THEN
    ALTER TABLE items ADD CONSTRAINT items_condition_usage_check
      CHECK (condition_usage IS NULL OR condition_usage IN ('nuevo', 'usado'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_condition_functionality_check'
  ) THEN
    ALTER TABLE items ADD CONSTRAINT items_condition_functionality_check
      CHECK (condition_functionality IS NULL OR condition_functionality IN (
        'perfecto', 'como_nuevo', 'normal', 'se_desconoce', 'no_funciona'));
  END IF;
END $$;

COMMIT;
