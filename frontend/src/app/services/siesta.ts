import { Injectable, signal, inject, OnDestroy } from '@angular/core';
import { InventoryService } from './inventory';

const IDLE_MS = 10 * 60 * 1000; // 10 minutos sin interacción → siesta

/**
 * Detecta inactividad del usuario y pone la app en "siesta":
 * - Cierra SSE y detiene el polling (vía InventoryService), con lo que
 *   cesa todo el tráfico y Neon puede autosuspenderse (no gasta compute).
 * - Muestra el banner "Aplicación en siesta"; al tocarlo, despierta y
 *   refresca todo lo necesario (reconecta SSE + refetch).
 */
@Injectable({
  providedIn: 'root'
})
export class SiestaService implements OnDestroy {
  private readonly inventoryService = inject(InventoryService);

  readonly asleep = signal<boolean>(false);

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly activityEvents = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];

  constructor() {
    if (typeof window === 'undefined') return;
    this.activityEvents.forEach(ev =>
      window.addEventListener(ev, this.onActivity, { passive: true })
    );
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resetIdleTimer();
  }

  ngOnDestroy(): void {
    if (typeof window === 'undefined') return;
    this.activityEvents.forEach(ev => window.removeEventListener(ev, this.onActivity));
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private onActivity = (): void => {
    if (this.asleep()) {
      // El usuario tocó para despertar (p. ej., el banner)
      this.wake();
      return;
    }
    this.resetIdleTimer();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.sleep();
    } else if (this.asleep()) {
      this.wake();
    }
  };

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.sleep(), IDLE_MS);
  }

  private sleep(): void {
    if (this.asleep()) return;
    console.log('[Siesta] Entrando en siesta: cerrando SSE y timers...');
    this.asleep.set(true);
    this.inventoryService.enterSiesta();
  }

  private wake(): void {
    if (!this.asleep()) return;
    console.log('[Siesta] Despertando: reconectando SSE y refrescando...');
    this.asleep.set(false);
    this.inventoryService.wake();
    this.resetIdleTimer();
  }

  /** Llamado por el banner al hacer clic. */
  requestWake(): void {
    this.wake();
  }
}
