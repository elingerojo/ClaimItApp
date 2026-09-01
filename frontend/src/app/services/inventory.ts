import { Injectable, signal, OnDestroy, inject } from '@angular/core';
import { Item, ItemStatus } from '@claimitapp/shared';
import { railwayApiUrl } from '../app.config';
import { UserService } from './user';
import { ToastService } from './toast';

export interface QueueEntry {
  userUuid: string;
  username: string;
  claimedAt: string;
  pickupDeadline: string | null;
}

export interface ItemWithQueue extends Item {
  visibilityLevel?: number | null;
  eventId?: string | null;
  visibleAt?: string | null;
  availableFrom?: string | null;
  effectiveAvailableFrom?: string | null;
  canClaim?: boolean;
  myPickupDeadline?: string | null;
  queue: Array<QueueEntry>;
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

  // SSE reconnection tracking (exponential backoff)
  private sseRetryCount = 0;
  private readonly MAX_RETRIES = 5;
  private sseClient: EventSource | null = null;
  private pollingIntervalId: number | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private sseRetryTimerId: number | null = null;

  // Claim rate limiting (cooldown between claims per user)
  private lastClaimTime = new Map<string, number>(); // userUuid -> timestamp
  private readonly CLAIM_COOLDOWN_MS = 2000; // 2 seconds

  constructor() {
    this.fetchInitialInventory();
    this.initializeSseStream();
  }

  private async fetchInitialInventory(): Promise<void> {
    try {
      // Enviar el userUuid para que el feed calcule la disponibilidad efectiva
      // (effectiveAvailableFrom/canClaim) y el deadline del usuario según su rol.
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
   * Refetches the inventory feed (with the current user's uuid) so the role /
   * deadline indicators stay fresh after a claim, session change or event
   * mutation.
   */
  async refresh(): Promise<void> {
    await this.fetchInitialInventory();
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
      const updateData = JSON.parse(event.data) as {
        itemId: string;
        status: ItemStatus;
        userUuid?: string;
        username: string;
        queuePosition: number;
        title?: string;
        description?: string | null;
        infoUrl?: string | null;
        evicted?: boolean;
        pickedUp?: boolean;
        evictedUsername?: string;
        newFirstUsername?: string;
        reason?: string;
        pickupDeadline?: string | null;
      };

      // "Ahora eres el primero en la fila" (auto-advance de cola)
      if (
        updateData.newFirstUsername &&
        updateData.newFirstUsername === this.userService.currentUsername()
      ) {
        this.toastService.info('👑 Ahora eres el primero en la fila!');
      }

      // Perform local micro-mutations on the matching array target inside your state tree
      this.itemsSignal.update(currentItems =>
        currentItems.map(item => {
          if (item.id !== updateData.itemId) return item;

          let updatedQueue = item.queue;

          if (updateData.evicted && updateData.userUuid) {
            // Remove evicted user from queue
            updatedQueue = item.queue.filter(q => q.userUuid !== updateData.userUuid);
          } else if (updateData.userUuid) {
            // Only modify queue when event carries a userUuid (absent in title-only edits)
            const existing = item.queue.find(q => q.userUuid === updateData.userUuid);
            if (existing) {
              updatedQueue = item.queue.map(q =>
                q.userUuid === updateData.userUuid
                  ? { ...q, pickupDeadline: updateData.pickupDeadline ?? q.pickupDeadline }
                  : q
              );
            } else {
              updatedQueue = [
                ...item.queue,
                {
                  userUuid: updateData.userUuid,
                  username: updateData.username,
                  claimedAt: new Date().toISOString(),
                  pickupDeadline: updateData.pickupDeadline ?? null
                }
              ];
            }
          }

          return {
            ...item,
            status: updateData.status,
            queue: updatedQueue,
            ...(updateData.title !== undefined && { title: updateData.title }),
            ...(updateData.description !== undefined && { description: updateData.description }),
            ...(updateData.infoUrl !== undefined && { infoUrl: updateData.infoUrl }),
            ...(updateData.pickupDeadline !== undefined &&
              updateData.userUuid === this.userService.currentUuid() && {
                myPickupDeadline: updateData.pickupDeadline
              })
          };
        })
      );
    });

    // Intercept deletion vectors so removed assets disappear from every view
    eventSource.addEventListener('item_deleted', (event: MessageEvent) => {
      this.sseRetryCount = 0; // Reset counter on successful event
      const deleteData = JSON.parse(event.data) as { itemId: string; title?: string };
      this.itemsSignal.update(currentItems =>
        currentItems.filter(item => item.id !== deleteData.itemId)
      );
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
   * Dispatches data out to claims transaction handlers
   * Enforces 2-second cooldown between claims per user to prevent accidental duplicates
   */
  async submitClaim(itemId: string, userUuid: string, email: string | null, phone: string | null): Promise<any> {
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
      // Refrescar para reflejar el deadline asignado al primer en fila
      this.refresh().catch(() => {});
      return result;
    } catch (error) {
      // Reset cooldown on error so user can retry
      this.lastClaimTime.delete(userUuid);
      throw error;
    }
  }
}
