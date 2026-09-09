-- ============================================================================
-- Migration 0003 (v2): admin sessions + SSE feed history + audit log
-- ============================================================================
-- Subsistemas CONSERVADOS (D6): admin (sesiones por dispositivo), SSE/feed y
-- auditoría. Recreados como tablas de soporte (sin dependencias entre sí).
--
-- Aplicar automáticamente con db-reset.js (orden léxico) o manualmente con:
--   node scripts/run-migration.js database/migrations/0003_admin_sessions_feed_audit.sql
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Sesiones de administrador (token solo como SHA-256; expiración deslizante
--    de 48h calculada con last_used_at, sin columna expires_at)
-- ----------------------------------------------------------------------------
CREATE TABLE admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,        -- SHA-256 del token de sesión
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_label TEXT
);

CREATE INDEX idx_admin_sessions_last_used_at ON admin_sessions (last_used_at);

-- ----------------------------------------------------------------------------
-- 2. Historial de feeds SSE (write-behind; leído por cache/appStore)
-- ----------------------------------------------------------------------------
CREATE TABLE feed_history (
  id BIGSERIAL PRIMARY KEY,
  event_name VARCHAR(64) NOT NULL,
  event_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feed_history_created ON feed_history (created_at DESC);

-- ----------------------------------------------------------------------------
-- 3. Auditoría de acciones (admin y sistema)
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(50) NOT NULL,            -- ITEM_CREATED, CLAIM_EVICTED, ...
  admin_code_suffix VARCHAR(4),           -- últimos 4 del código admin (enmascarado)
  item_id UUID REFERENCES items (id) ON DELETE SET NULL,
  user_id UUID REFERENCES users (uuid) ON DELETE SET NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_action ON audit_log (action);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_item ON audit_log (item_id);
CREATE INDEX idx_audit_user ON audit_log (user_id);

COMMIT;
