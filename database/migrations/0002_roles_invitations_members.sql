-- ============================================================================
-- Migration 0002 (v2): invitaciones en cascada + membresías
-- ============================================================================
-- Subsistemas CONSERVADOS (D6):
--   event_invitations — códigos crípticos por evento/rol (cascada 1-a-1 por rol).
--   event_members     — membresía por evento SIN rol (el rol global de users es
--                       la única fuente de verdad) y SIN bonus_hours.
--                       Conserva sanciones de confianza (expiraciones_acumuladas)
--                       y bloqueo de invitar (bloqueado_invitar).
--
-- Dependencias: events y users existen (init.sql).
-- Aplicar automáticamente con db-reset.js (orden léxico) o manualmente con:
--   node scripts/run-migration.js database/migrations/0002_roles_invitations_members.sql
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Invitaciones en cascada (código por evento+rol)
-- ----------------------------------------------------------------------------
CREATE TABLE event_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL
    CHECK (role IN ('familiares', 'amigos', 'conocidos', 'publico')),
  code TEXT NOT NULL UNIQUE,            -- hash críptico (p. ej. "a3Fk8Zw...")
  created_by UUID REFERENCES users (uuid),   -- opcional (eventos del admin: NULL)
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, role)
);

CREATE INDEX idx_event_invitations_event ON event_invitations (event_id);
CREATE INDEX idx_event_invitations_code ON event_invitations (code);

-- ----------------------------------------------------------------------------
-- 2. Membresías (sin rol, sin bonus_hours)
-- ----------------------------------------------------------------------------
CREATE TABLE event_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_uuid UUID NOT NULL REFERENCES users (uuid) ON DELETE CASCADE,
  invited_by UUID REFERENCES users (uuid) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expiraciones_acumuladas INTEGER NOT NULL DEFAULT 0 CHECK (expiraciones_acumuladas >= 0),
  bloqueado_invitar BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (event_id, user_uuid)
);

CREATE INDEX idx_event_members_event ON event_members (event_id);
CREATE INDEX idx_event_members_user ON event_members (user_uuid);

COMMIT;
