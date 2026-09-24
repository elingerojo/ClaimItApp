import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastHost } from './components/toast-host/toast-host';
import { SiestaBanner } from './components/siesta-banner/siesta-banner';
import { ToastService } from './services/toast';
import { HistoryBackService } from './services/history-back';

/** Ventana del doble-toque para salir (P2). */
const DOUBLE_BACK_WINDOW_MS = 2000;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, SiestaBanner],
  template: `
    <router-outlet />
    <app-toast-host />
    <app-siesta-banner />
  `,
  styles: [],
})
export class App {
  private readonly historyBack = inject(HistoryBackService);
  private readonly toastService = inject(ToastService);
  private lastRootBackAt = 0;

  constructor() {
    if (typeof window === 'undefined') return;
    this.historyBack.seedFloor(() => this.handleRootBack());
  }

  /** true = quedarse en la app (el servicio reempuja el piso); false = salir. */
  private handleRootBack(): boolean {
    const now = Date.now();
    if (now - this.lastRootBackAt < DOUBLE_BACK_WINDOW_MS) return false;
    this.lastRootBackAt = now;
    this.toastService.info('Presiona de nuevo para salir');
    return true;
  }
}
