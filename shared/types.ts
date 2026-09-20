/**
 * shared/types.ts — Contrato de tipos de la capa shared (Estrategia temporal v2).
 *
 * Convención de nombres:
 *  - Tipos/DTO orientados a la API y al dominio usan camelCase (Item, ClaimV2,
 *    ItemTemporalState, PickupSchedule) porque el backend los serializa a JSON
 *    camelCase para frontend.
 *  - Los tipos que reflejan UNA COLUMNA JSONB persistida tal cual
 *    (`items.frozen_schedule`) usan snake_case y espejan EXACTAMENTE las llaves
 *    documentadas en `database/init.sql`, para que la Fase 3 (backend) pueda
 *    escribir el JSON a la BD sin mapeo extra.
 *
 * Fuente de verdad del schema: `database/init.sql` + migraciones 0001..0004 y
 * el plan maestro `plans/estrategia-temporal-v2.md` (§4 reglas deterministas).
 */

export type ItemCategory =
  | 'Kitchen'
  | 'Electronics'
  | 'Decor'
  | 'Books'
  | 'Media'
  | 'Clothing'
  | 'Bedding'
  | 'Shoes'
  | 'Accessories'
  | 'Bathroom'
  | 'Office'
  | 'Utilities'
  | 'Cleaning'
  | 'Sports'
  | 'Misc.';

/**
 * Tipo de código de barras detectado por Gemini en la captura.
 * UPC/EAN/ISBN se consultan a la API de precios; ASIN solo se persiste
 * (UPCitemdb no indexa códigos de Amazon).
 */
export type BarcodeType = 'UPC' | 'EAN' | 'ASIN' | 'ISBN';

/**
 * Estado físico del item (`items.condition_grade`): catálogo ORDENADO de mejor a
 * peor (rank 7→1), 100% manual (lo captura el ADMIN; nunca derivado, nunca IA) y
 * SOLO informativo (no altera precio, multiplicadores, visibilidad, fases ni
 * reglas de claim).
 *
 * El orden de render, las etiquetas ES, el tono de chip y la composición típica
 * documentada viven en `shared/itemCondition.ts` (fuente única del catálogo);
 * aquí solo se declara el vocabulario. Dirección de importación: itemCondition.ts
 * importa de types.ts, NUNCA al revés (evita un ciclo).
 */
export type ConditionGrade =
  | 'nuevo_sellado'
  | 'como_nuevo'
  | 'excelente'
  | 'bueno'
  | 'regular'
  | 'con_fallas'
  | 'para_refacciones';

/** Empaque del item (`items.condition_packaging`). */
export type ConditionPackaging =
  | 'original_sellado'
  | 'original_abierto'
  | 'envuelto_sin_caja'
  | 'sin_empaque';

/** Accesorios incluidos (`items.condition_accessories`). */
export type ConditionAccessories = 'todos' | 'algunos' | 'sin';

/** Uso previo (`items.condition_usage`). */
export type ConditionUsage = 'nuevo' | 'usado';

/**
 * Funcionamiento (`items.condition_functionality`). El identificador interno es
 * `perfecto` y NO el literal `'100'` propuesto inicialmente: un identificador
 * numérico en `VARCHAR + CHECK` envejece mal (nota de refinamiento, plan §2.2);
 * la etiqueta de UI sigue siendo "100% (perfecto)".
 */
export type ConditionFunctionality =
  | 'perfecto'
  | 'como_nuevo'
  | 'normal'
  | 'se_desconoce'
  | 'no_funciona';

/**
 * Estado LEGACY `items.status` (available | waitlist_open | unavailable).
 * Se conserva como columna de lectura para no romper contratos actuales; el
 * ciclo de vida v2 lo maneja `items.phase` (ItemPhase).
 */
export type ItemStatus = 'available' | 'waitlist_open' | 'unavailable';

/**
 * Fase v2 del artículo (`items.phase`) — fuente de verdad del ciclo de vida:
 *   claim_open        -> reclamo abierto ("Lo quiero" / FIFO, hasta T_inicio)
 *   pickup_turns      -> contenedor de recolección por turnos (posición activa)
 *   ventana_libre     -> ventana libre (primero que reclama se lo lleva)
 *   entregado         -> entregado (lo marca el ADMIN vía UI)
 *   enviado_a_caridad -> enviado a caridad (T_final alcanzado sin entrega)
 */
export type ItemPhase =
  | 'claim_open'
  | 'pickup_turns'
  | 'ventana_libre'
  | 'entregado'
  | 'enviado_a_caridad';

/** Estado de cada claim de la cola FIFO (registro forense). */
export type ClaimState = 'active' | 'cancelado_voluntario' | 'expirado' | 'void';

/**
 * Estado de evento v2 (`events.status`):
 *   draft -> scheduled (publicado) -> active (claims hasta claims_close_at) ->
 *   closing (contenedor en curso T_inicio..T_final) -> closed (caridad/fin)
 */
export type EventStatus = 'draft' | 'scheduled' | 'active' | 'closing' | 'closed';

/** Posición FIFO dentro de la cola de un item (máximo 3). */
export type FifoPosition = 1 | 2 | 3;

/** Roles del dominio (global + claims + matriz de confianza). */
export type Role = 'familiares' | 'amigos' | 'conocidos' | 'publico';

export const ROLES: readonly Role[] = ['familiares', 'amigos', 'conocidos', 'publico'];

export const ITEM_PHASES: readonly ItemPhase[] = [
  'claim_open',
  'pickup_turns',
  'ventana_libre',
  'entregado',
  'enviado_a_caridad'
];

export const CLAIM_STATES: readonly ClaimState[] = [
  'active',
  'cancelado_voluntario',
  'expirado',
  'void'
];

/** Item de catálogo (legacy; contrato actual del feed). */
export interface Item {
  id: string;
  title: string;
  description: string | null;
  /**
   * Detalle descriptivo editorial (columna `items.description_detail`): texto
   * ampliado que captura el ADMIN a mano, independiente de `description` (la
   * descripción generada por IA, cuya etiqueta de UI es "Descripción (IA)").
   * `null` (o ausente) = "no proporcionado" ⇒ la UI del visitante NO debe
   * renderizar bloque alguno para este campo.
   */
  descriptionDetail?: string | null;
  // ---- Estado físico (columna items.condition_*; captura manual del ADMIN).
  // Espejo camelCase de columnas `VARCHAR(20)` + CHECK. Todos opcionales y
  // NULL-ables: `null` (o ausente) = "no proporcionado" ⇒ la UI del visitante NO
  // debe renderizar el campo. Vocabulario en types.ts; catálogo ordenado,
  // etiquetas ES y tono de chip en shared/itemCondition.ts.
  conditionGrade?: ConditionGrade | null;
  conditionPackaging?: ConditionPackaging | null;
  conditionAccessories?: ConditionAccessories | null;
  conditionUsage?: ConditionUsage | null;
  conditionFunctionality?: ConditionFunctionality | null;
  category: ItemCategory;
  infoUrl: string | null;
  /**
   * Arreglo ordenado de URLs de fotos del Item (JSONB image_urls en la BD).
   * La lista/portada usa imageUrls[0]; el detalle muestra el resto como
   * thumbnails. Siempre contiene al menos 1 URL en items válidos.
   */
  imageUrls: string[];
  status: ItemStatus;
  /** Fase v2 (agregado informativo; el ciclo de vida lo lee el backend v2). */
  phase?: ItemPhase;
  createdAt: string;

  // ---- Análisis de precio de mercado por código de barras (captura + UPCitemdb).
  // Espejo camelCase de las columnas items.barcode / market_*. Valores
  // INFORMATIVOS (min/max/avg) que no participan en el precio por rol
  // (base × multiplicador). Todos opcionales: null cuando no hay análisis.
  barcode?: string | null;
  barcodeType?: BarcodeType | null;
  marketCurrency?: string | null;
  marketMinPrice?: number | null;
  marketMaxPrice?: number | null;
  marketAvgPrice?: number | null;
  marketOffersCount?: number | null;
  /** Instante del análisis (ISO) o null si no hay. */
  marketAnalyzedAt?: string | null;
}

/** Claim legacy (contrato histórico; la Fase 3 migra a ClaimV2). */
export interface Claim {
  id: string;
  itemId: string;
  userUuid: string;        // UUID del usuario (identificador real)
  username: string;        // Alias actual del usuario (texto decorativo)
  claimantEmail: string | null;
  claimantPhone: string | null;
  claimedAt: string;
}

/**
 * Claim v2 — espejo de la tabla `claims` del schema v2 (registro forense de la
 * cola FIFO). `fifo_position` (1..3) y `turn_v_expires_at` (V_N) son NULL hasta
 * que el item se congela en T_inicio; desde ahí son INMUTABLES.
 */
export interface ClaimV2 {
  id: string;
  itemId: string;
  userUuid: string;
  username: string | null;      // alias vigente (no denormalizado, decorativo)
  claimedAt: string;            // ISO claimed_at
  claimState: ClaimState;
  roleAtClaim: Role;            // rol al momento del claim (global role)
  fifoPosition: FifoPosition | null;
  turnVExpiresAt: string | null; // V_N inmutable tras congelar
  claimantEmail: string | null;
  claimantPhone: string | null;
}

/** Resultado de la resolución de sesión POST /api/session */
export interface SessionResponse {
  uuid: string;
  alias: string;
  email: string | null;
  phone: string | null;
  isNew: boolean;
  conflict?: boolean;
  storedUuid?: string;
  storedAlias?: string;
}

// ---------------------------------------------------------------------------
// Snapshot congelado (items.frozen_schedule JSONB)
// ---------------------------------------------------------------------------

/** Posición 1..3 dentro del snapshot congelado (solo posiciones OCUPADAS). */
export interface FrozenSchedulePosition {
  /** claim_id del claim que ocupa la posición (forense). */
  claim_id: string;
  /** 1..3. */
  position: FifoPosition;
  /** Rol del claim al congelar (nunca null: solo se persisten ocupadas). */
  role: Role;
  /** Porción del contenedor asignada a la posición (entero 0..100). */
  share_pct: number;
  /** V_expires_at (V_N) de la posición en ISO — inmutable. */
  v_expires_at: string;
}

/**
 * Snapshot congelado del calendario v2, espejo de `items.frozen_schedule`
 * (JSONB). Llaves snake_case = llaves reales de la BD (ver init.sql §items).
 *
 * Se persiste UNA sola vez al llegar a T_inicio (o en la primera lectura con
 * now >= claims_close_at) y NO se recoloca tras cancelaciones/expirios: el
 * dominó hereda el V fijo de la siguiente posición. `positions` solo contiene
 * posiciones ocupadas (1..N en orden); las posiciones vacías quedan como
 * `v2`/`v3`... = null en los campos `v1`/`v2`/`v3`.
 */
export interface FrozenSchedule {
  version: 2;
  /** Instante real del congelamiento (ISO). */
  frozen_at: string;
  /** claims_close_at (T_inicio, ISO). */
  t_inicio: string;
  /** pickup_deadline (T_final / caridad, ISO). */
  t_final: string;
  /** Contenedor rígido en segundos = pickup_deadline − claims_close_at. */
  c_total_seconds: number;
  /** Vmin en entero % (15..25) usado para la porción pública. */
  vmin_pct: number;
  /** Vencimiento de la posición 1 (ISO) o null si vacía. */
  v1: string | null;
  /** Vencimiento de la posición 2 (ISO) o null si vacía. */
  v2: string | null;
  /** Vencimiento de la posición 3 (ISO) o null si vacía. */
  v3: string | null;
  /**
   * Inicio de la ventana libre (ISO): V de la última posición ocupada; si la
   * cola quedó vacía al congelar, es claims_close_at (100% libre).
   */
  ventana_libre_starts_at: string;
  /** Envío a caridad planificado = t_final (ISO). */
  charity_at: string;
  /** Posiciones ocupadas (1..N, orden FIFO). Vacías ausentes. */
  positions: FrozenSchedulePosition[];
}

/** Porción calculada (fase de reclamo/estado-temporal) de una posición. */
export interface TurnSlice {
  position: FifoPosition;
  /** Rol del ocupante; null = posición vacía (share 0). */
  role: Role | null;
  /** Porción 0..1 del contenedor que consume la posición (o 0 si vacía). */
  share: number;
}

/**
 * Calendario v2 COMPUTADO de forma pura (sin DB). Output de
 * `buildPickupSchedule`. Los `v1/v2/v3` son los Vencimientos acumulativos:
 *   V1 = T_inicio + C_total·s1
 *   V2 = V1       + C_total·s2
 *   V3 = V2       + C_total·s3
 */
export interface PickupSchedule {
  /** claims_close_at (T_inicio) en ISO. */
  claimsCloseAt: string;
  /** pickup_deadline (T_final) en ISO. */
  pickupDeadline: string;
  /** Contenedor rígido en segundos. */
  cTotalSeconds: number;
  /** Vmin 0..1 usado para las porciones públicas. */
  vmin: number;
  /** V1 ISO o null (posición 1 vacía). */
  v1: string | null;
  /** V2 ISO o null (posición 2 vacía). */
  v2: string | null;
  /** V3 ISO o null (posición 3 vacía). */
  v3: string | null;
  /** Inicio de la ventana libre (ISO); cola vacía => claimsCloseAt. */
  freeWindowStart: string;
  /** Envío a caridad = pickupDeadline (ISO). */
  charityAt: string;
  /** Porción y rol de las 3 posiciones (vacías incluidas, con share 0). */
  slices: TurnSlice[];
}

// ---------------------------------------------------------------------------
// GET /api/items/:id/estado-temporal — respuesta (contrato del plan §4.4)
// ---------------------------------------------------------------------------

/** Códigos de `estado_actual` de un item (ver plan §4.4 mermaid). */
export type ItemTemporalStateCode =
  /** Pre-T_inicio: reclamo FIFO abierto (o aún no habilitado/visible). */
  | 'CLAIM_ABIERTO'
  /** Contenedor en curso: turno de la posición 1. */
  | 'TURNO_1'
  /** Contenedor en curso: turno de la posición 2. */
  | 'TURNO_2'
  /** Contenedor en curso: turno de la posición 3. */
  | 'TURNO_3'
  /** Ventana libre: cualquier persona reclama directo (sin FIFO). */
  | 'VENTANA_LIBRE'
  /** Entregado (lo marca el ADMIN). */
  | 'ENTREGADO'
  /** Enviado a caridad (T_final alcanzado sin entrega). */
  | 'ENVIADO_A_CARIDAD';

/** Línea de tiempo fija (calendario congelado) dentro de la respuesta. */
export interface FixedTimeline {
  vencimiento_posicion_1: string | null;
  vencimiento_posicion_2: string | null;
  vencimiento_posicion_3: string | null;
  ventana_libre: string | null;
  caridad_final: string | null;
}

/** Participante (claim) dentro de la respuesta de estado-temporal. */
export interface TemporalParticipant {
  claimId: string;
  userUuid: string;
  username: string | null;
  claimState: ClaimState;
  roleAtClaim: Role | null;
  fifoPosition: FifoPosition | null;
  turnVExpiresAt: string | null;
  claimedAt: string | null;
}

/**
 * Respuesta del endpoint de estado temporal (contrato final):
 * `estado_actual`, `tiempo_restante_turno_activo_segundos`,
 * `linea_tiempo_fija {vencimiento_posicion_1..3, ventana_libre, caridad_final}`
 * y `participantes`.
 */
export interface ItemTemporalState {
  itemId: string;
  phase: ItemPhase;
  estado_actual: ItemTemporalStateCode;
  /** Segundos restantes del turno/estado activo (null si no aplica). */
  tiempo_restante_turno_activo_segundos: number | null;
  /** Calendario fijo; null si el item aún no se congela (pre-T_inicio). */
  linea_tiempo_fija: FixedTimeline | null;
  participantes: TemporalParticipant[];
}

// ---------------------------------------------------------------------------
// Recepción / entrega por usuario (admin) — pantalla "Registrar entrega"
// ---------------------------------------------------------------------------

/** Usuario devuelto por la búsqueda admin (GET /api/admin/users?q=). */
export interface AdminUserSummary {
  uuid: string;
  alias: string;
  email: string | null;
  phone: string | null;
  globalRole: Role;
}

/** Motivo por el que un item aparece como recogible por un usuario. */
export type AdminPickableReason = 'open_claim_first' | 'turn_holder' | 'free_window_claim';

/**
 * Item donde el usuario es el titular de mayor prioridad de recogida (o tiene un
 * claim activo en ventana libre). Es el contrato de GET /api/admin/pickups.
 */
export interface AdminPickableItem {
  itemId: string;
  claimId: string;
  title: string;
  category: ItemCategory | string;
  imageUrl: string | null;
  phase: ItemPhase;
  /**
   * Precio visible por rol del usuario (precioBaseCosto × multiplicador del rol
   * global); null si el item no tiene precio base. Mismo valor que ve el usuario
   * en su feed.
   */
  precioVisible: number | null;
  /** Posición FIFO del titular (1..3) o índice 1-based si aún no se congela. */
  priorityPosition: number | null;
  /** Vencimiento del turno del titular (ISO) o null si no aplica. */
  turnVExpiresAt: string | null;
  /** Total de claims activos del item (incluyendo al titular). */
  holderCount: number;
  /** Claims activos con mayor prioridad que el usuario (0 = es el titular). */
  holdersAhead: number;
  eventId: string | null;
  eventTitle: string | null;
  claimedAt: string;
  reason: AdminPickableReason;
}

/** Respuesta de GET /api/admin/pickups?userUuid=. */
export interface AdminPickupListResponse {
  user: AdminUserSummary;
  items: AdminPickableItem[];
  counts: { total: number; byPhase: Record<string, number> };
}

/** Resultado por item de POST /api/admin/pickups/deliver. */
export interface AdminBatchDeliverItemResult {
  itemId: string;
  ok: boolean;
  code?: string;
  message?: string;
  deliveredClaimId?: string | null;
  deliveredUsername?: string | null;
  deliveredAt?: string;
  /** Precio visible por rol del item entregado (solo en resultados `ok`); null sin precio. */
  precioVisible?: number | null;
}

/** Respuesta de POST /api/admin/pickups/deliver. */
export interface AdminBatchDeliverResponse {
  success: boolean;
  userUuid: string;
  results: AdminBatchDeliverItemResult[];
  deliveredCount: number;
  failedCount: number;
  /** Suma de los `precioVisible` de los items entregados `ok` (0 si ninguno tiene precio). */
  totalAmount: number;
}
