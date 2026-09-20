-- ============================================================================
-- Migration 0009 (v2): cierra claims 'active' en items TERMINALES
-- ============================================================================
-- Regla: un item en fase terminal (entregado / enviado_a_caridad) NO debe
-- conservar claims con claim_state='active'.
--
-- Contexto (bug real): deliverItemByAdmin() marcaba el item como 'entregado'
-- pero dejaba el claim del receptor con claim_state='active' ("registro
-- forense"), y hacía void solo a "los demás". Como applyDueTransitions() ni
-- siquiera procesa items terminales, ese claim nunca expiraba. Eso provocaba:
--   - "turnos fantasma" en la UI admin (leyenda "⏰ recoge antes de …" sobre
--     items ya entregados),
--   - contaminación del ledger (filtra claim_state='active'),
--   - conteo indebido en el límite de apartados simultáneos del evento.
--
-- El receptor sigue registrado en items.delivered_claim_id (FK forense a
-- claims, ON DELETE SET NULL), así que marcar el claim como 'void' conserva
-- el histórico sin perder la referencia de quién recibió el objeto.
--
-- Idempotente: solo toca claims 'active' cuyo item esté en fase terminal.
-- Aplicar con:
--   node scripts/run-migration.js database/migrations/0009_void_active_claims_on_terminal_items.sql
-- ============================================================================

BEGIN;

UPDATE claims c
SET claim_state = 'void',
    updated_at = NOW()
FROM items i
WHERE c.item_id = i.id
  AND c.claim_state = 'active'
  AND i.phase IN ('entregado', 'enviado_a_caridad');

COMMIT;
