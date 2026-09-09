import { Injectable, signal, OnDestroy, inject } from '@angular/core';
import {
  Item,
  ItemPhase,
  ItemStatus,
  ClaimState,
  FifoPosition,
  Role,
  FixedTimeline,
  FrozenSchedule
} from '@claimitapp/shared';
import { railwayApiUrl } from '../app.config';
import { UserService } from './user';
import { ToastService } from './toast';

/**
 * Entrada de la cola forense v2 (espejo del payload `queue` del feed y del
 * listado admin). Corresponde 1:1 con `StoreClaim` del backend
 * (claims.claim_state / fifo_position / turn_v_expires_at, etc.).
 */
export interface QueueEntry {
  id: string;
  itemId?: string | null;
  userUuid: string;
  /** Alias vigente (no denormalizado; decorativo). */
  username: string | null;
  claimedAt: string;
  claimState: ClaimState;
  roleAtClaim?: Role | null;
  fifoPosition: FifoPosition | null;
  /** V_N (Vencimiento del turno) inmutable tras congelar en T_inicio. */
  turnVExpiresAt: string | null;
  claimantEmail?: string | null;
  claimantPhone?: string | null;
}

/** Mi claim ACTIVO del usuario en un item (payload `myClaim` del feed v2). */
export interface MyClaim {
  claimId: string;
  claimState: ClaimState;
  roleAtClaim: Role;
  fifoPosition: FifoPosition | null;
  turnVExpiresAt: string | null;
  claimedAt: string;
}

/**
 * Estado temporal compacto por item que entrega el feed (`temporalState`):
 * `estado_actual` (CLAIM_ABIERTO/TURNO_1..3/VENTANA_LIBRE/ENTREGADO/
 * ENVIADO_A_CARIDAD), segundos restantes del estado activo y la línea de
 * tiempo fija (V1..V3 / ventana libre / caridad) una vez congelado.
 */
export interface TemporalStateCompact {
  estado_actual: string;
  tiempo_restante_turno_activo_segundos: number | null;
  linea_tiempo_fija: FixedTimeline | null;
}

export interface EventSummary {
  id: string;
  title: string | null;
  status: string;
  published_at: string | null;
  available_from: string | null;
  claims_close_at: string | null;
  pickup_deadline: string | null;
  pickup_schedule_info?: string | null;
}

/**
 * Item del feed v2 (dinámico por rol). El backend expone la fase (`phase`),
 * el estado temporal compacto (`temporalState`), las ventanas por rol
 * (visibleAtForRole / claimFromForRole), la cola forense v2 (`queue` con
 * claimState/fifoPosition), mi claim activo (`myClaim`) y los flags
 * `canClaim` / `claimsClosed`. Ya NO se consumen los campos legacy
 * per-claim (myPickupWindowHours / myPickupDeadline / effectiveClaimsCloseAt /
 * effectivePickupDeadline): se usan `eventSummary.claims_close_at` y
 * `eventSummary.pickup_deadline` (fechas de evento v2).
 */
export interface ItemWithQueue extends Item {
  visibilityLevel?: number | null;
  eventId?: string | null;
  /**
   * Fase v2 (fuente de verdad del ciclo de vida). El feed/admin siempre lo
   * envía; se declara opcional (lo hereda de `Item`) para no forzar objetos
   * construidos a mano en la zona admin (que se adapta en la Fase 4b).
   */
  frozenAt?: string | null;
  freeWindowOpenedAt?: string | null;
  deliveredAt?: string | null;
  charityAt?: string | null;
  /**
   * Snapshot congelado v2 (`items.frozen_schedule` JSONB) que entrega el
   * listado admin (GET /api/admin/items). Espeja las llaves snake_case de la
   * BD: v1/v2/v3, ventana_libre_starts_at, charity_at y `positions`. El feed
   * público en cambio usa `temporalState.linea_tiempo_fija`.
   */
  frozenSchedule?: FrozenSchedule | null;
  /** Rol efectivo del usuario en este evento (feed v2, dinámico puro). */
  myRoleInEvent?: Role;
  /** Adelanto de visibilidad del rol (matriz) en horas. */
  advancePubHours?: number;
  /** Adelanto de inicio de claim del rol (matriz) en horas. */
  advanceDispHours?: number;
  /** Instante en que el item se vuelve visible para el rol (ISO). */
  visibleAtForRole?: string | null;
  /** Instante en que el rol puede empezar a reclamar (ISO). */
  claimFromForRole?: string | null;
  /** true cuando el rol puede apretar "Lo quiero" (o capturar en ventana libre). */
  canClaim?: boolean;
  /** true cuando ya no se aceptan más separaciones (post T_inicio / fase no abierta). */
  claimsClosed?: boolean;
  /** Estado temporal compacto v2 (estado_actual + countdown + línea fija). */
  temporalState?: TemporalStateCompact | null;
  /** Apartados activos del usuario en el evento (límite simultáneo real). */
  activeApartadosInEvent?: number;
  /** Límite de apartados simultáneos del rol en el evento. */
  simultaneousLimit?: number;
  /** Precio por rol (base × multiplicador de la matriz). */
  precioVisible?: number | null;
  eventSummary?: EventSummary | null;
  /** Cola forense v2 (todos los estados). */
  queue: Array<QueueEntry>;
  /** Mi claim ACTIVO (null si no estoy en la cola). */
  myClaim?: MyClaim | null;
}

/** Payload tipado de un `item_updated` SSE (razones v2). */
interface ItemUpdatedSse {
  itemId: string;
  status?: ItemStatus;
  phase?: ItemPhase;
  userUuid?: string;
  username?: string | null;
  claimId?: string;
  queuePosition?: number;
  claimState?: ClaimState;
  fifoPosition?: number;
  turnVExpiresAt?: string | null;
  freeWindowOpenedAt?: string | null;
  delivered?: boolean;
  deliveredClaimId?: string | null;
  deliveredUsername?: string | null;
  deliveredAt?: string | null;
  charityAt?: string | null;
  frozenAt?: string | null;
  queueCount?: number;
  voidedCount?: number;
  activeRemaining?: number;
  expired?: Array<{ userUuid: string; username: string | null; role: string; sanctioned: string }>;
  voided?: Array<{ claimId: string; userUuid: string; username: string | null }>;
  reason?: string;
  title?: string;
  description?: string | null;
  infoUrl?: string | null;
  imageUrls?: string[];
  claimedAt?: string;
  category?: string;
}

@Injectable({
  providedIn: 'root'
})
export class InventoryService implements OnDestroy {
  private readonly apiUrl = railwayApiUrl;
  private readonly userService = inject(UserService);
  private readonly toastService = inject(ToastService);

  // Core application visual layer signaling pipeline
  private readonly itemsSignal = signal<ItemWithQueue[]>([]);
  readonly items = this.itemsSignal.asReadonly();

  // ---- Vista admin (Gestionar Inventario): lista filtrada por estatus ----
  // El servidor devuelve SOLO los buckets pedidos (?statuses=...) + counts de
  // todos los estatus. Se mantiene separado de `items` (feed público) para no
  // filtrar objetos draft/no publicados al catálogo de visitantes.
  private readonly adminItemsSignal = signal<ItemWithQueue[]>([]);
  readonly adminItems = this.adminItemsSignal.asReadonly();
  private readonly adminCountsSignal = signal<Record<string, number>>({});
  readonly adminCounts = this.adminCountsSignal.asReadonly();
  private readonly adminLoadedSignal = signal<boolean>(false);
  readonly adminLoaded = this.adminLoadedSignal.asReadonly();

  // Parámetros del último loadAdminItems (para refrescar ante SSE).
  private adminLoadParams: { statuses: string[]; token: string } | null = null;
  private adminRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // SSE reconnection tracking (exponential backoff)
  private sseRetryCount = 0;
  private readonly MAX_RETRIES = 5;
  private sseClient: EventSource | null = null;
  private pollingIntervalId: number | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private sseRetryTimerId: number | null = null;

  // Resync debounce tras mutaciones SSE (las transiciones v2 recolocan la cola
  // y las posiciones FIFO en el servidor; el feed es la fuente de verdad).
  private sseRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Claim rate limiting (cooldown between claims per user)
  private lastClaimTime = new Map<string, number>(); // userUuid -> timestamp
  private readonly CLAIM_COOLDOWN_MS = 2000; // 2 seconds

  constructor() {
    this.fetchInitialInventory();
    this.initializeSseStream();
  }

  private async fetchInitialInventory(): Promise<void> {
    try {
      // Enviar el userUuid para que el feed calcule visibilidad/canClaim y el
      // estado temporal por rol (feed v2 dinámico puro).
      const userUuid = this.userService.currentUuid();
      const url = userUuid ? `${this.apiUrl}/items?userUuid=${encodeURIComponent(userUuid)}` : `${this.apiUrl}/items`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to retrieve baseline catalog metadata.');
      const data: ItemWithQueue[] = await response.json();
      this.itemsSignal.set(data);
    } catch (error) {
      console.error('Core visual collection mapping failed:', error);
    }
  }

  /**
   * Refetches the inventory feed (with the current user's uuid) so the phase /
   * temporal state / queue flags stay fresh after a claim, phase transition,
   * session change or event mutation.
   */
  async refresh(): Promise<void> {
    await this.fetchInitialInventory();
  }

  /**
   * Carga el listado admin filtrado por estatus de evento desde
   * GET /api/admin/items?statuses=... (admin only). Reemplaza adminItems con
   * los items de los buckets pedidos y actualiza los conteos por estatus.
   * Sin gatekeeping del feed público: aquí también aparecen drafts/ocultos.
   */
  async loadAdminItems(statuses: string[], adminToken: string): Promise<void> {
    if (!statuses.length) return;
    this.adminLoadParams = { statuses, token: adminToken };
    const url = `${this.apiUrl}/admin/items?statuses=${encodeURIComponent(statuses.join(','))}`;
    const response = await fetch(url, {
      headers: { 'X-Admin-Token': adminToken }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error((body as any).error || 'No autorizado para listar el inventario.');
    }
    const data = await response.json();
    this.adminItemsSignal.set((data.items ?? []) as ItemWithQueue[]);
    this.adminCountsSignal.set((data.counts ?? {}) as Record<string, number>);
    this.adminLoadedSignal.set(true);
  }

  /**
   * Refresca la vista admin con la última combinación de estatus cargada.
   * Solo actúa si antes hubo un loadAdminItems (adminLoaded).
   */
  async refreshAdminItems(): Promise<void> {
    const params = this.adminLoadParams;
    if (!params || !this.adminLoadedSignal()) return;
    await this.loadAdminItems(params.statuses, params.token);
  }

  /** Refresco admin con debounce ante mutaciones SSE (evita ráfagas). */
  private scheduleAdminRefresh(): void {
    if (!this.adminLoadedSignal() || !this.adminLoadParams) return;
    if (this.adminRefreshTimer !== null) clearTimeout(this.adminRefreshTimer);
    this.adminRefreshTimer = setTimeout(() => {
      this.adminRefreshTimer = null;
      this.refreshAdminItems().catch(() => {});
    }, 400);
  }

  /** ¿El usuario actual está (o estuvo) relacionado con la cola de este item? */
  private iAmInItemQueue(queue: Array<QueueEntry> | undefined): boolean {
    const myUuid = this.userService.currentUuid();
    if (!myUuid || !queue) return false;
    return queue.some((q) => q.userUuid === myUuid);
  }

  /**
   * Toasts útiles ante transiciones v2 (solo cuando el evento toca al usuario
   * actual o a un objeto del que forma parte, para no spamear a todos).
   */
  private toastForPhaseChange(oldItem: ItemWithQueue | undefined, data: ItemUpdatedSse): void {
    const reason = data.reason;
    const myUuid = this.userService.currentUuid();
    const actorIsMe = !!data.userUuid && data.userUuid === myUuid;
    if (!reason || !myUuid) return;
    const queue = oldItem?.queue;
    const iHaveAnyClaim = this.iAmInItemQueue(queue);

    switch (reason) {
      case 'item_frozen': {
        if (!iHaveAnyClaim) break;
        const activeBefore = (queue ?? []).filter((c) => c.claimState === 'active');
        const firstWasMe = activeBefore[0]?.userUuid === myUuid;
        if (firstWasMe) {
          this.toastService.info('👑 ¡Tu turno comienza! Recoge dentro de tu ventana.');
        }
        break;
      }
      case 'turn_expired': {
        const expiredMe = (data.expired ?? []).some((e) => e.userUuid === myUuid);
        if (expiredMe) {
          this.toastService.error('⏰ Tu turno expiró: el objeto pasó al siguiente. Afecta tu confianza en el evento.');
        } else if (iHaveAnyClaim) {
          const activeBefore = (queue ?? []).filter((c) => c.claimState === 'active');
          const firstWasMe = activeBefore[0]?.userUuid === myUuid;
          if (firstWasMe) this.toastService.info('👑 ¡Tu turno comienza! Quien estaba adelante no recogió.');
        }
        break;
      }
      case 'free_window_opened': {
        if (!actorIsMe && iHaveAnyClaim) {
          this.toastService.info('🎉 Ventana libre abierta: ¡apúrate, el primero que reclame se lo lleva!');
        }
        break;
      }
      case 'delivered_by_admin':
      case 'ventana_libre_capture': {
        if (!iHaveAnyClaim && data.deliveredUsername !== this.userService.currentUsername()) break;
        if (iHaveAnyClaim) {
          this.toastService.success('✅ Artículo entregado. Ya no está disponible.');
        } else if (data.deliveredUsername === this.userService.currentUsername()) {
          this.toastService.success('✅ ¡Te lo llevaste! El artículo quedó entregado.');
        }
        break;
      }
      case 'sent_to_charity': {
        if (iHaveAnyClaim) {
          this.toastService.info('💔 El artículo fue enviado a caridad (nadie lo recogió a tiempo).');
        }
        break;
      }
      default:
        break;
    }
  }

  private initializeSseStream(): void {
    if (typeof window === 'undefined') return;

    const eventSource = new EventSource(`${this.apiUrl}/stream`);
    this.sseClient = eventSource;

    // Al reconectarse con éxito, salir del modo polling de respaldo
    eventSource.onopen = () => {
      this.sseRetryCount = 0;
      this.stopFallbackPolling();
      if (this.sseRetryTimerId !== null) {
        clearInterval(this.sseRetryTimerId);
        this.sseRetryTimerId = null;
      }
    };

    // Intercept update vectors fired directly out of claims allocation procedures
    eventSource.addEventListener('item_updated', (event: MessageEvent) => {
      this.sseRetryCount = 0; // Reset counter on successful event
      let updateData: ItemUpdatedSse;
      try {
        updateData = JSON.parse(event.data) as ItemUpdatedSse;
      } catch {
        return;
      }
      if (!updateData.itemId) return;

      const oldByRef = this.itemsSignal().find((i) => i.id === updateData.itemId);
      this.toastForPhaseChange(oldByRef, updateData);

      // Aplicar micro-mutaciones baratas (fase/status/campos escalares) de forma
      // inmediata; la cola/turnos/posiciones FIFO se resincronizan con el feed
      // (las transiciones v2 las recalcula el backend, que es la fuente de verdad).
      this.itemsSignal.update((currentItems) =>
        currentItems.map((item) => {
          if (item.id !== updateData.itemId) return item;
          const next: ItemWithQueue = {
            ...item,
            ...(updateData.phase !== undefined && { phase: updateData.phase as ItemPhase }),
            ...(updateData.status !== undefined && { status: updateData.status }),
            ...(updateData.frozenAt !== undefined && { frozenAt: updateData.frozenAt }),
            ...(updateData.freeWindowOpenedAt !== undefined && {
              freeWindowOpenedAt: updateData.freeWindowOpenedAt
            }),
            ...(updateData.deliveredAt !== undefined && { deliveredAt: updateData.deliveredAt }),
            ...(updateData.charityAt !== undefined && { charityAt: updateData.charityAt }),
            ...(updateData.title !== undefined && { title: updateData.title }),
            ...(updateData.description !== undefined && { description: updateData.description }),
            ...(updateData.infoUrl !== undefined && { infoUrl: updateData.infoUrl }),
            ...(updateData.imageUrls !== undefined && { imageUrls: updateData.imageUrls })
          };
          return next;
        })
      );

      // Resincronizar con el feed (debounce) para que phase, temporalState,
      // cola (claimState/fifoPosition/turnVExpiresAt) y myClaim converjan a la
      // verdad del servidor tras cada transición v2.
      if (this.sseRefreshTimer !== null) clearTimeout(this.sseRefreshTimer);
      this.sseRefreshTimer = setTimeout(() => {
        this.sseRefreshTimer = null;
        this.refresh().catch(() => {});
      }, 250);

      // La vista admin (adminItems) se mantiene en vivo ante mutaciones del
      // feed, reutilizando la combinación de estatus activa en ese momento.
      this.scheduleAdminRefresh();
    });

    // Intercept deletion vectors so removed assets disappear from every view
    eventSource.addEventListener('item_deleted', (event: MessageEvent) => {
      this.sseRetryCount = 0; // Reset counter on successful event
      let deleteData: { itemId: string; title?: string };
      try {
        deleteData = JSON.parse(event.data) as { itemId: string; title?: string };
      } catch {
        return;
      }
      if (!deleteData.itemId) return;
      this.itemsSignal.update((currentItems) =>
        currentItems.filter((item) => item.id !== deleteData.itemId)
      );
      this.scheduleAdminRefresh();
    });

    // Cambio de vanity name (alias): actualiza el alias mostrado en las colas de
    // todos los items, sin necesidad de re-fetch completo.
    eventSource.addEventListener('user_renamed', (event: MessageEvent) => {
      this.sseRetryCount = 0; // Reset counter on successful event
      let renameData: { userUuid: string; alias: string };
      try {
        renameData = JSON.parse(event.data) as { userUuid: string; alias: string };
      } catch {
        return;
      }
      if (!renameData.userUuid || !renameData.alias) return;
      this.itemsSignal.update((currentItems) =>
        currentItems.map((item) => ({
          ...item,
          queue: item.queue.map((q) =>
            q.userUuid === renameData.userUuid ? { ...q, username: renameData.alias } : q
          )
        }))
      );
      this.scheduleAdminRefresh();
    });

    eventSource.onerror = () => {
      this.handleSseError();
    };
  }

  /**
   * Handle SSE disconnection with exponential backoff
   * Retries up to 5 times: 1s, 2s, 4s, 8s, 16s
   * After 5 failures, activate polling fallback at 30s interval
   * (el polling solo corre en estado despierto; la siesta lo detiene).
   */
  private handleSseError(): void {
    console.warn(
      `[SSE] Disconnected. Retry attempt ${this.sseRetryCount + 1}/${this.MAX_RETRIES}`
    );

    // Close current connection
    if (this.sseClient) {
      this.sseClient.close();
      this.sseClient = null;
    }

    if (this.sseRetryCount < this.MAX_RETRIES) {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delayMs = Math.pow(2, this.sseRetryCount) * 1000;
      this.sseRetryCount++;

      console.log(
        `[SSE] Reconnecting in ${delayMs}ms (exponential backoff attempt #${this.sseRetryCount})`
      );

      this.reconnectTimeoutId = setTimeout(() => {
        this.reconnectTimeoutId = null;
        this.initializeSseStream();
      }, delayMs);
    } else {
      // Fallback: polling after 5 failed reconnection attempts
      console.error(
        '[SSE] Failed after 5 reconnection attempts. Activating polling fallback (30s interval).'
      );
      this.activateFallbackPolling();
    }
  }

  /**
   * Fallback polling mechanism (30s interval)
   * Only activated if SSE fails 5+ times. Mientras está activo, se reintenta
   * SSE cada 60s para volver al streaming cuando el servidor se restaure.
   */
  private activateFallbackPolling(): void {
    if (this.pollingIntervalId !== null) {
      return; // Already polling
    }

    console.warn('[FALLBACK] Polling activated. SSE appears to be down.');

    this.pollingIntervalId = window.setInterval(() => {
      this.fetchInitialInventory().catch((err) => {
        console.error('[FALLBACK] Polling refresh failed:', err);
      });
    }, 30_000); // 30 seconds

    // Reintentar SSE periódicamente para salir del polling cuando se restaure
    if (this.sseRetryTimerId === null) {
      this.sseRetryTimerId = window.setInterval(() => {
        if (this.sseClient) return; // Ya reconectado
        console.log('[SSE] Reintentando conexión desde fallback polling...');
        this.sseRetryCount = 0;
        this.initializeSseStream();
      }, 60_000); // 60 seconds
    }
  }

  /**
   * Stop fallback polling if SSE is restored
   */
  private stopFallbackPolling(): void {
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
      console.log('[FALLBACK] Polling deactivated. SSE restored.');
    }
  }

  /**
   * Siesta: cierra SSE y detiene cualquier timer/polling pendiente para que
   * cesen por completo los requests (Neon puede autosuspenderse).
   */
  enterSiesta(): void {
    if (this.sseClient) {
      this.sseClient.close();
      this.sseClient = null;
    }
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    this.stopFallbackPolling();
    if (this.sseRetryTimerId !== null) {
      clearInterval(this.sseRetryTimerId);
      this.sseRetryTimerId = null;
    }
    if (this.sseRefreshTimer !== null) {
      clearTimeout(this.sseRefreshTimer);
      this.sseRefreshTimer = null;
    }
    this.sseRetryCount = 0;
    console.log('[SSE] Siesta: conexión y timers detenidos.');
  }

  /**
   * Despierta: reconecta SSE y refresca los datos.
   * /api/items se sirve desde el store en RAM (sin query a Neon salvo que
   * Railway haya reiniciado y necesite rehidratar).
   */
  wake(): void {
    this.initializeSseStream();
    this.fetchInitialInventory();
  }

  /**
   * Cleanup on component destroy
   */
  ngOnDestroy(): void {
    if (this.sseClient) {
      this.sseClient.close();
    }
    this.stopFallbackPolling();
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
    }
    if (this.sseRetryTimerId !== null) {
      clearInterval(this.sseRetryTimerId);
    }
    if (this.adminRefreshTimer !== null) {
      clearTimeout(this.adminRefreshTimer);
      this.adminRefreshTimer = null;
    }
    if (this.sseRefreshTimer !== null) {
      clearTimeout(this.sseRefreshTimer);
      this.sseRefreshTimer = null;
    }
  }

  /**
   * Removes an item from the inventory catalog (admin only)
   */
  async deleteItem(itemId: string, adminToken: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/admin/items/${itemId}`, {
      method: 'DELETE',
      headers: {
        'X-Admin-Token': adminToken
      }
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'No fue posible eliminar el objeto.');
    }
    return result;
  }

  /**
   * Dispatches data out to claims transaction handlers.
   * Enforces 2-second cooldown between claims per user to prevent accidental
   * duplicates.
   *
   * v2 — el mismo POST /api/claims cubre dos casos:
   *  - FIFO ("Lo quiero") cuando phase='claim_open' y el rol está dentro de su
   *    ventana [claim_from(rol), claims_close_at) y la cola no está llena.
   *  - Captura directa ("Me lo llevo") cuando phase='ventana_libre' → el item
   *    queda entregado al instante (respuesta con `delivered: true`).
   */
  async submitClaim(
    itemId: string,
    userUuid: string,
    email: string | null,
    phone: string | null
  ): Promise<any> {
    // Check cooldown: prevent multiple claims within 2 seconds
    const lastTime = this.lastClaimTime.get(userUuid) || 0;
    const timeSinceLastClaim = Date.now() - lastTime;

    if (timeSinceLastClaim < this.CLAIM_COOLDOWN_MS) {
      const waitTime = Math.ceil((this.CLAIM_COOLDOWN_MS - timeSinceLastClaim) / 1000);
      throw new Error(`Please wait ${waitTime}s before claiming another item`);
    }

    // Record claim timestamp for future cooldown checks
    this.lastClaimTime.set(userUuid, Date.now());

    try {
      const response = await fetch(`${this.apiUrl}/claims`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, userUuid, email, phone })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'The system was unable to register your claim request.');
      }
      // Refrescar para reflejar la nueva fase / posición FIFO / captura.
      this.refresh().catch(() => {});
      return result;
    } catch (error) {
      // Reset cooldown on error so user can retry
      this.lastClaimTime.delete(userUuid);
      throw error;
    }
  }

  /**
   * Salida voluntaria del visitante de la Línea de Espera de un objeto
   * ("Ya no lo quiero" — v2, dominó NEUTRO, sin sanción).
   * POST /api/claims/leave. La cola se recompone en el backend; el
   * SSE/refresh mantiene el feed al día.
   */
  async submitLeave(itemId: string, userUuid: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/claims/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, userUuid })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'No se pudo salir de la lista.');
    }
    this.refresh().catch(() => {});
    return result;
  }

  /**
   * Expulsión forzada de un usuario de la Línea de Espera de un objeto
   * (admin). POST /api/admin/evict exige el userUuid exacto del claim.
   */
  async evictClaimant(itemId: string, userUuid: string, adminToken: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/admin/evict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminToken
      },
      body: JSON.stringify({ itemId, userUuid })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Error en la expulsión.');
    }
    return result;
  }

  /**
   * Marca 'item recogido' como ENTREGADO (admin, v2 D6).
   * POST /api/admin/items/:id/deliver.
   *
   * Body opcional `{ claimId }`:
   *  - pickup_turns: se entrega al titular del turno activo (no hace falta
   *    claimId; el backend usa el primer activo).
   *  - ventana_libre: `claimId` puede apuntar a un claim activo concreto de la
   *    ventana, o `null` para una entrega walk-in (sin apartado previo).
   * Tras el éxito la cola se conserva como forense y el resto de activos quedan
   * `void` (sin sanción). El SSE ya refresca la vista; el caller re-llama
   * refreshAdminItems para converger al instante.
   */
  async deliverItem(itemId: string, adminToken: string, claimId?: string | null): Promise<any> {
    const response = await fetch(`${this.apiUrl}/admin/items/${encodeURIComponent(itemId)}/deliver`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminToken
      },
      body: JSON.stringify({ claimId: claimId ?? null })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'No se pudo marcar el objeto como entregado.');
    }
    return result;
  }
}
