import { Injectable, signal, computed } from '@angular/core';
import { railwayApiUrl } from '../app.config';

export interface UserSession {
  uuid: string;
  alias: string;
  email: string | null;
  phone: string | null;
  globalRole: string | null;
}

export interface SessionResult {
  success?: boolean;
  conflict?: boolean;
  browserUuid?: string;
  storedUuid?: string;
  storedAlias?: string;
  message?: string;
  /** Indica que la BD fue reiniciada desde la última visita del usuario */
  databaseReset?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class UserService {
  private readonly apiUrl = railwayApiUrl;

  // Reactive internal signal primitive tracking session state
  private readonly userSessionSignal = signal<UserSession | null>(null);

  // Read-only computed signal streams for clean layout component bindings
  readonly session = this.userSessionSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.userSessionSignal() !== null);
  readonly currentUuid = computed(() => this.userSessionSignal()?.uuid || '');
  readonly currentUsername = computed(() => this.userSessionSignal()?.alias || '');
  /** Rol global (familiares > amigos > conocidos > publico). Default: publico. */
  readonly currentRole = computed(() => this.userSessionSignal()?.globalRole || 'publico');

  constructor() {
    this.loadSessionFromStorage();
  }

  private loadSessionFromStorage(): void {
    if (typeof window === 'undefined') return;

    const uuid = localStorage.getItem('claimit_uuid');
    const alias = localStorage.getItem('claimit_alias');
    if (!uuid || !alias) return;

    this.userSessionSignal.set({
      uuid,
      alias,
      email: localStorage.getItem('claimit_email'),
      phone: localStorage.getItem('claimit_phone'),
      globalRole: localStorage.getItem('claimit_role')
    });
  }

  /**
   * Indica si el UUID se cargó de una sesión previa (localStorage)
   * o se acaba de generar ahora (primera vez en este navegador).
   * Útil para el servidor en caso de migraciones de BD (V1 → V2).
   */
  private getIsFromSession(): boolean {
    return !!localStorage.getItem('claimit_uuid');
  }

  /**
   * Obtiene UUID existente de localStorage o genera uno nuevo con crypto.randomUUID()
   */
  private getOrCreateUuid(): string {
    let uuid = localStorage.getItem('claimit_uuid');
    if (!uuid) {
      uuid = crypto.randomUUID();
      localStorage.setItem('claimit_uuid', uuid);
    }
    return uuid;
  }

  /**
   * Resuelve la sesión contra el servidor.
   * El UUID se origina en el navegador; el servidor valida y responde.
   *
   * Retorna:
   *   { success: true }                    → sesión resuelta, alias libre
   *   { conflict: true, storedUuid, ... } → alias ocupado por otro UUID
   */
  async resolveSession(alias: string, email: string | null, phone: string | null): Promise<SessionResult> {
    const uuid = this.getOrCreateUuid();
    const isFromSession = this.getIsFromSession();

    try {
      const response = await fetch(`${this.apiUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, alias, email, phone, isFromSession })
      });

      const data = await response.json();

      if (data.conflict) {
        // Conflicto: alias ocupado por otro UUID
        return {
          conflict: true,
          browserUuid: uuid,
          storedUuid: data.storedUuid,
          storedAlias: data.storedAlias,
          message: data.message || `El alias "${alias}" ya está siendo usado.`
        };
      }

      if (!response.ok) {
        throw new Error(data.error || 'Error al resolver sesión');
      }

      // Éxito: guardar sesión con UUID, alias y rol global
      this.commitSession(data.uuid, data.alias, data.email, data.phone, data.globalRole);

      // Si el servidor indica que hubo un reset de BD, lo comunicamos
      const result: SessionResult = { success: true };
      if (data.databaseReset) {
        result.databaseReset = true;
      }
      return result;

    } catch (err: any) {
      throw new Error(err.message || 'Error de red al conectar con el servidor.');
    }
  }

  /**
   * El usuario acepta el UUID del servidor (opción "continuar en nuevo dispositivo").
   * Actualiza localStorage con el UUID almacenado en el servidor. */
  acceptServerUuid(
    storedUuid: string,
    alias: string,
    email: string | null,
    phone: string | null,
    globalRole: string | null = null
  ): void {
    // Reemplazar el UUID del browser con el del servidor
    localStorage.setItem('claimit_uuid', storedUuid);
    this.commitSession(storedUuid, alias, email, phone, globalRole);
  }

  /**
   * Actualiza únicamente el rol global de la sesión (p. ej. tras aceptar una
   * invitación que eleva el rol).
   */
  setRole(role: string): void {
    const current = this.userSessionSignal();
    if (!current) return;
    this.commitSession(current.uuid, current.alias, current.email, current.phone, role);
  }

  /**
   * Guarda los datos de sesión en localStorage y actualiza el signal reactivo.
   * NOTA: Este método se mantiene como fallback para uso local sin servidor.
   * Para uso normal, usar resolveSession() que llama al backend.
   */
  saveSession(alias: string, email: string | null, phone: string | null): void {
    const uuid = this.getOrCreateUuid();
    this.commitSession(uuid, alias.trim(), email?.trim() || null, phone?.trim() || null, 'publico');
  }

  private commitSession(
    uuid: string,
    alias: string,
    email: string | null,
    phone: string | null,
    globalRole: string | null
  ): void {
    const cleanAlias = alias.trim();

    localStorage.setItem('claimit_uuid', uuid);
    localStorage.setItem('claimit_alias', cleanAlias);

    if (email?.trim()) localStorage.setItem('claimit_email', email.trim());
    else localStorage.removeItem('claimit_email');

    if (phone?.trim()) localStorage.setItem('claimit_phone', phone.trim());
    else localStorage.removeItem('claimit_phone');

    if (globalRole) localStorage.setItem('claimit_role', globalRole);
    else localStorage.removeItem('claimit_role');

    this.userSessionSignal.set({
      uuid,
      alias: cleanAlias,
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      globalRole: globalRole || null
    });
  }

  /**
   * Clears saved tokens to reset identity configuration contexts
   */
  clearSession(): void {
    localStorage.removeItem('claimit_uuid');
    localStorage.removeItem('claimit_alias');
    localStorage.removeItem('claimit_email');
    localStorage.removeItem('claimit_phone');
    localStorage.removeItem('claimit_role');
    this.userSessionSignal.set(null);
  }
}
