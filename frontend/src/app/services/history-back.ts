import { Injectable } from '@angular/core';

/** Capa descartable: devuelve true para conservarse (reempuja el guard) o false si ya se cerró. */
export interface BackLayer {
  onBack: () => boolean;
}

interface LayerEntry {
  layer: BackLayer;
  /** true mientras la entrada de historial de esta capa siga pendiente de consumir. */
  alive: boolean;
}

/**
 * Coordina el botón back con los overlays de la app mediante la History API.
 *
 * - `arm` empuja una entrada extra con la MISMA URL (no se toca el address bar),
 *   así el router de Angular no observa ninguna navegación.
 * - Un único listener de `popstate` consume la capa superior de la pila.
 * - `disarm` deshace la entrada con `history.back()` en los cierres programáticos
 *   (X / backdrop), ignorando el `popstate` resultante.
 * - `seedFloor` siembra la entrada-piso: cuando no quedan capas, el back no sale
 *   del sitio y el callback del dueño decide entre quedarse o salir.
 */
@Injectable({ providedIn: 'root' })
export class HistoryBackService {
  private readonly stack: LayerEntry[] = [];
  private readonly popHandler = () => this.handlePop();
  private ignoreNextPop = false;
  private floorSeeded = false;
  private onRootBack: (() => boolean) | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('popstate', this.popHandler);
  }

  /** true si hay alguna capa (modal) esperando el back. */
  hasActiveLayers(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Siembra la entrada-piso. `onRootBack` devuelve true para quedarse en la app
   * (el servicio reempuja el piso) o false para permitir la salida.
   */
  seedFloor(onRootBack: () => boolean): void {
    if (typeof window === 'undefined' || this.floorSeeded) return;
    this.onRootBack = onRootBack;
    this.floorSeeded = true;
    this.pushEntry();
  }

  /** Agrega una capa descartable y su entrada de historial. */
  arm(onBack: () => boolean): BackLayer {
    const layer: BackLayer = { onBack };
    if (typeof window === 'undefined') return layer;
    this.stack.push({ layer, alive: true });
    this.pushEntry();
    return layer;
  }

  /** Cierre programático: quita la capa y consume su entrada con history.back(). */
  disarm(layer: BackLayer): void {
    const idx = this.stack.findIndex((e) => e.layer === layer);
    if (idx === -1) return;
    const [entry] = this.stack.splice(idx, 1);
    if (typeof window === 'undefined' || !entry.alive) return;
    this.ignoreNextPop = true;
    window.history.back();
  }

  private pushEntry(): void {
    window.history.pushState(
      { ...(window.history.state ?? {}), claimitLayer: this.stack.length + 1 },
      '',
      window.location.href
    );
  }

  private handlePop(): void {
    if (this.ignoreNextPop) {
      this.ignoreNextPop = false;
      return;
    }

    const top = this.stack[this.stack.length - 1];
    if (top) {
      const keep = top.layer.onBack();
      if (keep) {
        this.pushEntry();
      } else {
        top.alive = false;
        this.stack.pop();
      }
      return;
    }

    // Sin capas: política de raíz (D2/P2).
    if (!this.floorSeeded || !this.onRootBack) return;
    if (this.onRootBack()) {
      this.pushEntry();
      return;
    }
    this.floorSeeded = false;
    window.removeEventListener('popstate', this.popHandler);
    window.history.back();
  }
}
