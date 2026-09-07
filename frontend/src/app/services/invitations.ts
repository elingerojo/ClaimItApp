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

/** Resultado de resolver un código de invitación suelto (?invite=TOKEN). */
export interface ResolvedInvite {
  /** true = código válido y activo; false = inválido/inactivo (o fallo de red). */
  valid: boolean;
  /** true cuando no se pudo llegar al servidor (el token se conserva, sin gate). */
  network?: boolean;
  eventId?: string;
  eventTitle?: string;
  role?: string;
  error?: string;
}

const PENDING_KEY = 'claimit_pending_invite';
const PENDING_ALIAS_KEY = 'claimit_pending_invite_alias';

/**
 * Servicio que detecta una invitación pendiente en la URL del HOME
 * (https://SITIO/?invite=TOKEN[&apodo=JUAN]).
 *
 * A diferencia de la versión anterior (token solo en memoria y URL limpiada de
 * inmediato), el código se PERSISTE en localStorage y se recupera al arrancar.
 * Así una recarga o una visita posterior no pierden la invitación: el alta del
 * usuario con el nivel invitado siempre puede completarse.
 *
 * No muestra ninguna pantalla extra: la "magia" ocurre al resolver la
 * identidad. El apodo opcional (?apodo=) se conserva como sugerencia para
 * pre-llenar el popup de bienvenida (siempre editable; el invitado confirma).
 */
@Injectable({ providedIn: 'root' })
export class InvitationService {
  private readonly apiUrl = railwayApiUrl;

  private readonly codeSignal = signal<string | null>(null);
  private readonly aliasSignal = signal<string | null>(null);

  readonly hasPending = computed(() => this.codeSignal() !== null);
  /** Apodo sugerido por el anfitrión (?apodo=) para pre-llenar el popup. */
  readonly suggestedAlias = this.aliasSignal.asReadonly();

  constructor() {
    this.init();
  }

  /** Captura ?invite= / ?apodo= de la URL y limpia la URL sin recargar. */
  private init(): void {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite');
    const apodo = params.get('apodo');

    if (code) {
      // Invitación fresca en la URL: persistirla y limpiar la URL (más discreto).
      this.codeSignal.set(code);
      if (apodo?.trim()) this.aliasSignal.set(apodo.trim());
      this.persist();

      params.delete('invite');
      params.delete('apodo');
      const qs = params.toString();
      const cleanUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    } else {
      // Sin invitación nueva en la URL: recuperar la pendiente persistida
      // (sobrevive a reloads y visitas posteriores).
      const persisted = localStorage.getItem(PENDING_KEY);
      if (persisted) this.codeSignal.set(persisted);
      const persistedAlias = localStorage.getItem(PENDING_ALIAS_KEY);
      if (persistedAlias) this.aliasSignal.set(persistedAlias);
    }
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    const code = this.codeSignal();
    if (code) localStorage.setItem(PENDING_KEY, code);
    else localStorage.removeItem(PENDING_KEY);

    const alias = this.aliasSignal();
    if (alias) localStorage.setItem(PENDING_ALIAS_KEY, alias);
    else localStorage.removeItem(PENDING_ALIAS_KEY);
  }

  /** Descarta cualquier invitación pendiente (memoria + localStorage). */
  clearPending(): void {
    this.codeSignal.set(null);
    this.aliasSignal.set(null);
    this.persist();
  }

  private pendingCode(): string | null {
    return this.codeSignal();
  }

  /**
   * Resuelve el código pendiente contra el backend (GET /api/invitations/resolve)
   * para mostrar el título del evento y decidir si la invitación eleva por
   * encima de 'publico'. Ante un código inválido/inactivo lo descarta; ante un
   * fallo de red lo conserva (valid=false, network=true) sin bloquear.
   */
  async resolvePending(): Promise<ResolvedInvite | null> {
    const code = this.pendingCode();
    if (!code) return null;

    try {
      const res = await fetch(`${this.apiUrl}/invitations/resolve?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) {
        // Código inválido o inactivo → descartarlo para no bloquear/gatear.
        this.clearPending();
        return { valid: false, error: data.error || 'La invitación ya no es válida.' };
      }
      return {
        valid: true,
        eventId: data.eventId,
        eventTitle: data.eventTitle,
        role: data.role
      };
    } catch (err: any) {
      // Fallo de red: no sabemos el rol; conservar el pendiente y no gatear.
      return { valid: false, network: true, error: err.message || 'Error de red.' };
    }
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
        this.clearPending();
        return { accepted: false, error: data.error || 'La invitación ya no es válida.', invalid: true };
      }
      this.clearPending();
      return { accepted: true, role: data.role, message: data.message };
    } catch (err: any) {
      // Error de red: conservar el pendiente para reintentar más adelante.
      return { accepted: false, error: err.message || 'Error de red.', invalid: false };
    }
  }
}
