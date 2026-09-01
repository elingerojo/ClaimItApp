import { Injectable, signal } from '@angular/core';
import { railwayApiUrl } from '../app.config';

const ADMIN_TOKEN_STORAGE_KEY = 'claimit_admin_token';

/**
 * Gestión de la sesión de administrador.
 *
 * Flujo:
 * - login(password): valida el password contra el backend y guarda el token
 *   emitido en localStorage (sesión persistente sin reingresar password).
 * - validateSession(): valida el token guardado contra el backend al arrancar.
 * - logout(): revoca la sesión actual en el backend y limpia localStorage.
 *
 * La expiración (48h de inactividad) la controla el backend; ante un 401
 * este servicio limpia el token y exige un nuevo login.
 */
@Injectable({
  providedIn: 'root'
})
export class AdminTokenService {
  private readonly apiUrl = railwayApiUrl;

  readonly token = signal<string>(this.readStoredToken());
  readonly authenticated = signal<boolean>(false);
  readonly isLoggingIn = signal<boolean>(false);

  private readStoredToken(): string {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
  }

  private persistToken(token: string): void {
    this.token.set(token);
    if (typeof localStorage === 'undefined') return;
    if (token) {
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  }

  /**
   * Inicia sesión con el password del administrador. El backend emite un
   * token opaco que se guarda en localStorage. Cada dispositivo sin token
   * crea su propia sesión en el backend (multi-dispositivo).
   */
  async login(password: string, deviceLabel?: string): Promise<void> {
    this.isLoggingIn.set(true);
    try {
      const response = await fetch(`${this.apiUrl}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, deviceLabel })
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'No fue posible iniciar sesión.');
      }
      this.persistToken(result.token);
      this.authenticated.set(true);
    } finally {
      this.isLoggingIn.set(false);
    }
  }

  /**
   * Valida el token guardado contra el backend al iniciar la sesión del
   * navegador. Si la sesión expiró (48h sin uso) el backend responde 401
   * y aquí se limpia el token para exigir un nuevo login.
   */
  async validateSession(): Promise<boolean> {
    const currentToken = this.token();
    if (!currentToken) {
      this.authenticated.set(false);
      return false;
    }

    try {
      const response = await fetch(`${this.apiUrl}/admin/session`, {
        headers: { 'X-Admin-Token': currentToken }
      });
      if (response.ok) {
        this.authenticated.set(true);
        return true;
      }
      // 401: sesión expirada o inválida
      this.persistToken('');
      this.authenticated.set(false);
      return false;
    } catch {
      // Error de red: no podemos validar; no marcar como autenticado.
      this.authenticated.set(false);
      return false;
    }
  }

  /**
   * Cierra la sesión del dispositivo actual (revoca el token en el backend
   * y limpia localStorage). Best-effort: limpia local incluso si el backend
   * no responde.
   */
  async logout(): Promise<void> {
    const currentToken = this.token();
    if (currentToken) {
      try {
        await fetch(`${this.apiUrl}/admin/logout`, {
          method: 'POST',
          headers: { 'X-Admin-Token': currentToken }
        });
      } catch {
        // Ignorar: la limpieza local es la parte crítica.
      }
    }
    this.persistToken('');
    this.authenticated.set(false);
  }
}
