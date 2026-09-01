import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

/**
 * Servicio global de notificaciones tipo toast (sin dependencias externas).
 * Cada toast se auto-destruye tras una duración acorde a su tipo.
 */
@Injectable({
  providedIn: 'root'
})
export class ToastService {
  private readonly toastsSignal = signal<Toast[]>([]);
  readonly toasts = this.toastsSignal.asReadonly();

  private nextId = 1;
  private readonly durations: Record<ToastType, number> = {
    success: 3000,
    error: 6000,
    info: 4000,
  };

  success(message: string): void {
    this.show('success', message);
  }

  error(message: string): void {
    this.show('error', message);
  }

  info(message: string): void {
    this.show('info', message);
  }

  show(type: ToastType, message: string): void {
    const id = this.nextId++;
    this.toastsSignal.update(toasts => [...toasts, { id, type, message }]);
    setTimeout(() => this.dismiss(id), this.durations[type]);
  }

  dismiss(id: number): void {
    this.toastsSignal.update(toasts => toasts.filter(t => t.id !== id));
  }
}
