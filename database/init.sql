-- ============================================================================
-- database/init.sql — SCHEMA v2 (Estrategia temporal v2)
-- ============================================================================
-- Plan maestro (fuente de verdad): plans/estrategia-temporal-v2.md
-- Reglas originales: plans/events_time_distribution_rules-by-Google/rules-discovery-chat.md
-- Schema legacy de referencia (SOLO dump): plans/events_time_distribution_rules-by-Google/2026-09-08-14-57_db_schema.json
--
-- RESET completo aprobado (D1): DROP SCHEMA public CASCADE + este archivo +
-- migraciones numeradas database/migrations/*.sql (orden léxico) + re-seed.
--
-- Contenido de init.sql = "enums + tablas base": tipos ENUM + tablas núcleo
-- del dominio (users, events, items, claims). Las tablas de soporte
-- (invitaciones y membresías, admin/feed/audit, matriz de confianza + plantilla
-- de agenda) viven en las migraciones numeradas 0001..0004 para respetar el
-- patrón "init.sql + migraciones" que espera scripts/db-reset.js.
--
-- Este archivo NO es idempotente por diseño: solo corre sobre un schema recién
-- creado por db-reset.js (DROP SCHEMA ... CASCADE). Usar:
--   node scripts/db-reset.js --yes [--seed]
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tipos ENUM
-- ----------------------------------------------------------------------------

-- Categorías de artículos (contrato shared/types.ts ItemCategory).
CREATE TYPE item_category AS ENUM (
  'Kitchen', 'Electronics', 'Decor', 'Books', 'Media', 'Clothing', 'Bedding',
  'Shoes', 'Accessories', 'Bathroom', 'Office', 'Utilities', 'Cleaning',
  'Sports', 'Misc.'
);

-- Estado "status" LEGACY (contrato actual shared/types.ts ItemStatus:
-- available | waitlist_open | unavailable). Se conserva como columna de lectura
-- para no romper contratos actuales; el ciclo de vida v2 lo maneja items.phase.
-- En la fase de controllers v2 se re-derivará/convergerá con items.phase.
CREATE TYPE item_status AS ENUM ('available', 'waitlist_open', 'unavailable');

-- Fase v2 del artículo (fuente de verdad del ciclo de vida, D3/D4):
--   claim_open        -> reclamo abierto ("Lo quiero" / FIFO, hasta T_inicio)
--   pickup_turns      -> contenedor de recolección por turnos (posición activa)
--   ventana_libre     -> ventana libre (primero que reclama se lo lleva)
--   entregado         -> entregado (lo marca el ADMIN vía UI)
--   enviado_a_caridad -> enviado a caridad (T_final alcanzado sin entrega)
CREATE TYPE item_phase AS ENUM (
  'claim_open', 'pickup_turns', 'ventana_libre', 'entregado', 'enviado_a_caridad'
);

-- Estado de cada claim de la cola FIFO (registro forense, D6):
--   active                -> en cola / titular del turno activo
--   cancelado_voluntario  -> "Ya no lo quiero" (dominó neutral, sin sanción)
--   expirado              -> venció su V sin recoger (dispara sanción de confianza)
--   void                  -> perdió el derecho sin sanción (otro se llevó el
--                            item / cierre de cola por entrega o caridad)
CREATE TYPE claim_state AS ENUM ('active', 'cancelado_voluntario', 'expirado', 'void');

-- Estados de evento v2 (D5):
--   draft -> scheduled (publicado) -> active (claims abiertos hasta
--   claims_close_at) -> closing (contenedor de recolección en curso
--   T_inicio..T_final) -> closed (caridad alcanzada / fin)
CREATE TYPE event_status AS ENUM ('draft', 'scheduled', 'active', 'closing', 'closed');

-- ----------------------------------------------------------------------------
-- users — identidad global (el UUID lo genera el navegador, no la BD)
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  uuid UUID PRIMARY KEY,                    -- crypto.randomUUID() del navegador
  alias VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(255),
  global_role VARCHAR(20) NOT NULL DEFAULT 'publico'
    CHECK (global_role IN ('familiares', 'amigos', 'conocidos', 'publico')),
  bloqueado_apartar BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_users_alias_lower ON users (LOWER(alias));
CREATE INDEX idx_users_global_role ON users (global_role);

-- ----------------------------------------------------------------------------
-- events — contenedor POR EVENTO (D2)
-- ----------------------------------------------------------------------------
-- 4 marcas de tiempo del evento:
--   published_at     = P_pub: base de publicación (sin ventajas por rol).
--   available_from   = P_disp: base de disponibilidad / apertura de "Lo quiero".
--   claims_close_at  = T_inicio: último instante para unirse a la FIFO y
--                      comienzo de la recolección (se congela la cola).
--   pickup_deadline  = T_final: envío a caridad.
--
-- El contenedor de recolección rígido es C_total = pickup_deadline - claims_close_at.
-- NO hay columnas por rol en events (cero): publicación/"Lo quiero" es DINÁMICO
-- PURO leído de trust_levels_settings (advance_pub/disp_hours_default); los
-- porcentajes de recolección son constantes del motor (D3/D4).
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  published_at TIMESTAMPTZ,                 -- P_pub (base publicación)
  available_from TIMESTAMPTZ NOT NULL,      -- P_disp (base disponibilidad)
  claims_close_at TIMESTAMPTZ,              -- T_inicio (corte de la FIFO)
  pickup_deadline TIMESTAMPTZ NOT NULL,     -- T_final (caridad)
  status event_status NOT NULL DEFAULT 'draft',
  pickup_schedule_info TEXT,                -- nota informativa (nunca en cálculos)
  times_notes TEXT,                         -- nota markdown de tiempos (solo términos/condiciones, nunca en cálculos)
  conditions_notes TEXT,                    -- nota markdown de condiciones (solo términos/condiciones, nunca en cálculos)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT events_available_after_publish
    CHECK (published_at IS NULL OR available_from >= published_at),
  CONSTRAINT events_claims_after_available
    CHECK (claims_close_at IS NULL OR claims_close_at >= available_from),
  CONSTRAINT events_pickup_after_claims
    CHECK (claims_close_at IS NULL OR pickup_deadline > claims_close_at)
);

CREATE INDEX idx_events_created ON events (created_at DESC);
CREATE INDEX idx_events_available ON events (available_from);
CREATE INDEX idx_events_status ON events (status);

-- ----------------------------------------------------------------------------
-- items — artículo de la venta (event-first) con fases v2
-- ----------------------------------------------------------------------------
CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events (id) ON DELETE RESTRICT, -- event-first
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category item_category NOT NULL,
  info_url TEXT,
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,  -- arreglo ordenado de fotos
  status item_status NOT NULL DEFAULT 'available',  -- LEGACY/derivado (lectura)
  phase item_phase NOT NULL DEFAULT 'claim_open',   -- fase v2 (ciclo de vida)
  visibility_level INTEGER NOT NULL DEFAULT 4
    CHECK (visibility_level BETWEEN 0 AND 4),       -- 0=admin,4=publico
  -- Regla v2 "evento como fuente única": items NO tienen fechas propias. La
  -- visibilidad/apertura se deriva de events.published_at / events.available_from
  -- (cálculo por rol en tiempo de lectura). Sin columnas de calendario por item.
  precio_base_costo NUMERIC(10, 2),  -- precio base; por rol se calcula en lectura
  -- Análisis de precio de mercado por código de barras (captura + Gemini →
  -- UPCitemdb). Valores INFORMATIVOS min/max/avg; NO participan en el precio de
  -- venta por rol (base × multiplicador). Ver migración 0007.
  barcode VARCHAR(40),               -- UPC/EAN/ISBN/ASIN detectado (o NULL)
  barcode_type VARCHAR(10)
    CHECK (barcode_type IS NULL OR barcode_type IN ('UPC', 'EAN', 'ISBN', 'ASIN')),
  market_currency CHAR(3),           -- moneda de la fuente de ofertas (p. ej. USD)
  market_min_price NUMERIC(10, 2),   -- oferta más baja
  market_max_price NUMERIC(10, 2),   -- oferta más alta
  market_avg_price NUMERIC(10, 2),   -- promedio de las ofertas válidas
  market_offers_count INTEGER,       -- nº de ofertas usadas para el cálculo
  market_analyzed_at TIMESTAMPTZ,    -- cuándo se calculó el análisis
  -- Snapshot del calendario congelado IDEMPOTENTE (D4/D6). Se persiste UNA vez al
  -- llegar a T_inicio (o en la primera lectura con now >= claims_close_at) y no se
  -- recoloca tras cancelaciones/expirios (el dominó hereda el V fijo siguiente).
  -- Estructura JSONB documentada:
  -- {
  --   "version": 2,
  --   "frozen_at": "ISO",                  -- instante del congelamiento
  --   "t_inicio": "ISO", "t_final": "ISO",
  --   "c_total_seconds": 172800,
  --   "vmin_pct": 15,                      -- % del rol de menor jerarquía presente
  --   "ventana_libre_starts_at": "ISO",    -- inicio de la ventana libre (V última ocupada)
  --   "positions": [                       -- posiciones ocupadas 1..3
  --     { "claim_id": "...", "position": 1, "role": "amigos", "share_pct": 20,
  --       "v_expires_at": "ISO" }
  --   ]
  -- }
  frozen_schedule JSONB,
  frozen_at TIMESTAMPTZ,                    -- instante real del congelamiento
  free_window_opened_at TIMESTAMPTZ,        -- cuándo abrió la ventana libre
  delivered_claim_id UUID,                  -- claim que recibió (FK: migración 0001)
  delivered_at TIMESTAMPTZ,                 -- marca admin de "item recogido"
  charity_at TIMESTAMPTZ,                   -- envío a caridad (T_final)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_items_event ON items (event_id);
CREATE INDEX idx_items_phase ON items (phase);
CREATE INDEX idx_items_status ON items (status);
CREATE INDEX idx_items_visibility ON items (visibility_level);

-- ----------------------------------------------------------------------------
-- claims — cola FIFO por artículo (registro forense)
-- ----------------------------------------------------------------------------
-- La cola acepta hasta 3 claims (max_apartados_simultaneos no aplica a FIFO).
-- Orden = claimed_at ASC. Al llegar a T_inicio se congela: cada claim recibe
-- fifo_position (1..3) y turn_v_expires_at = su V_N (inmutable de ahí en adelante).
-- La entrega la marca el ADMIN: el item pasa a phase='entregado' y los claims
-- pendientes restantes pasan a claim_state='void' (conservados como registro).
CREATE TABLE claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  user_uuid UUID NOT NULL REFERENCES users (uuid) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_state claim_state NOT NULL DEFAULT 'active',
  role_at_claim VARCHAR(20) NOT NULL DEFAULT 'publico'
    CHECK (role_at_claim IN ('familiares', 'amigos', 'conocidos', 'publico')),
  fifo_position SMALLINT CHECK (fifo_position BETWEEN 1 AND 3), -- 1..3 al congelar
  turn_v_expires_at TIMESTAMPTZ,  -- V_N de la posición (inmutable tras congelar)
  claimant_email VARCHAR(255),
  claimant_phone VARCHAR(30),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_claims_item_claimed ON claims (item_id, claimed_at);
CREATE INDEX idx_claims_user ON claims (user_uuid);
CREATE INDEX idx_claims_state ON claims (claim_state);
-- Vencimientos de turno activos para el scheduler perezoso (lazy catch-up).
CREATE INDEX idx_claims_turn_v
  ON claims (turn_v_expires_at)
  WHERE turn_v_expires_at IS NOT NULL;
-- Un usuario solo puede tener UN claim activo por item (los 3 de la FIFO son de
-- usuarios distintos).
CREATE UNIQUE INDEX uq_claims_active_item_user
  ON claims (item_id, user_uuid)
  WHERE claim_state = 'active';
