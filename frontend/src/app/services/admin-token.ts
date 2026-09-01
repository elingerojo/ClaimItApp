import { Injectable, signal } from '@angular/core';

const ADMIN_TOKEN_STORAGE_KEY = 'claimit_admin_token';

@Injectable({
  providedIn: 'root'
})
export class AdminTokenService {
  readonly token = signal<string>(this.readStoredToken());
  readonly tokenAccepted = signal<boolean>(false);
  private tokenAcceptedTimer: ReturnType<typeof setTimeout> | null = null;

  private readStoredToken(): string {
    if (typeof localStorage === 'undefined') {
      return '';
    }

    return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
  }

  setToken(val: string): void {
    const normalized = val.trim();
    this.token.set(normalized);

    if (!normalized) {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      return;
    }

    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalized);
  }

  onTokenEnter(inputEl: HTMLInputElement): void {
    inputEl.blur(); // Dismiss mobile keyboard

    if (!this.token()?.trim()) return;

    this.tokenAccepted.set(true);

    if (this.tokenAcceptedTimer) clearTimeout(this.tokenAcceptedTimer);
    this.tokenAcceptedTimer = setTimeout(() => {
      this.tokenAccepted.set(false);
      this.tokenAcceptedTimer = null;
    }, 2000);
  }
}
