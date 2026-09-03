import { Injectable, signal, computed } from '@angular/core';
import { railwayApiUrl } from '../app.config';

export interface AcceptPendingResult {
  accepted: boolean;
  /** Rol otorgado tras aceptar (para actualizar la sesión local). */
  role?: string;
  message?: string;
  error?: string;
  /** true cuando el código resultó inválido/inactivo y ya se descartó. */
  invalid?: boolean;
}

/**
 * Servicio que detecta una invitación pendiente en la URL del HOME
 * (https://SITIO/?invite=TOKEN), la conserva en memoria y la acepta contra el
 * backend una vez que la identidad del usuario queda resuelta.
 *
 * No muestra ninguna pantalla extra: la "magia" ocurre al resolver el alias.
 * El argumento se limpia de la URL apenas la app arranca (menos evidente).
 */
@Injectable({ providedIn: 'root' })
export class InvitationService {
  private readonly apiUrl = railwayApiUrl;

  private readonly pendingCode = signal<string | null>(null);
  readonly hasPending = computed(() => this.pendingCode() !== null);

  constructor() {
    this.captureFromUrl();
  }

  /** Lee ?invite= del query actual y limpia la URL sin recargar. */
  private captureFromUrl(): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite');
    if (!code) return;

    this.pendingCode.set(code);

    params.delete('invite');
    const qs = params.toString();
    const cleanUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }

  /** Descarta cualquier invitación pendiente (p. ej. al cerrar sesión). */
  clearPending(): void {
    this.pendingCode.set(null);
  }

  /**
   * Acepta la invitación pendiente (si existe) con el UUID ya resuelto.
   * En éxito devuelve el rol otorgado; ante un código inválido/inactivo lo
   * descarta y devuelve error (el usuario se queda como publico). Un error de
   * red conserva el pendiente para reintentar en la próxima resolución.
   */
  async acceptPending(userUuid: string): Promise<AcceptPendingResult> {
    const code = this.pendingCode();
    if (!code || !userUuid) return { accepted: false };

    try {
      const res = await fetch(`${this.apiUrl}/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationCode: code, userUuid })
      });
      const data = await res.json();
      if (!res.ok) {
        this.pendingCode.set(null);
        return { accepted: false, error: data.error || 'La invitación ya no es válida.', invalid: true };
      }
      this.pendingCode.set(null);
      return { accepted: true, role: data.role, message: data.message };
    } catch (err: any) {
      // Error de red: conservar el pendiente para reintentar más adelante.
      return { accepted: false, error: err.message || 'Error de red.', invalid: false };
    }
  }
}
