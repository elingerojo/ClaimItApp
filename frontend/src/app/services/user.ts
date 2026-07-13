import { Injectable, signal, computed } from '@angular/core';

export interface UserSession {
  username: string;
  email: string | null;
  phone: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class UserService {
  // Reactive internal signal primitive tracking session state
  private readonly userSessionSignal = signal<UserSession | null>(null);

  // Read-only computed signal streams for clean layout component bindings
  readonly session = this.userSessionSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.userSessionSignal() !== null);
  readonly currentUsername = computed(() => this.userSessionSignal()?.username || '');

  constructor() {
    this.loadSessionFromStorage();
  }

  private loadSessionFromStorage(): void {
    if (typeof window === 'undefined') return; // Strict safety guard against unexpected server environments
    
    const savedUsername = localStorage.getItem('claimit_username');
    if (!savedUsername) return;

    this.userSessionSignal.set({
      username: savedUsername,
      email: localStorage.getItem('claimit_email'),
      phone: localStorage.getItem('claimit_phone')
    });
  }

  /**
   * Encapsulates credentials locally inside memory partitions
   */
  saveSession(username: string, email: string | null, phone: string | null): void {
    const cleanUsername = username.trim();
    
    localStorage.setItem('claimit_username', cleanUsername);
    
    if (email?.trim()) localStorage.setItem('claimit_email', email.trim());
    else localStorage.removeItem('claimit_email');

    if (phone?.trim()) localStorage.setItem('claimit_phone', phone.trim());
    else localStorage.removeItem('claimit_phone');

    this.userSessionSignal.set({
      username: cleanUsername,
      email: email?.trim() || null,
      phone: phone?.trim() || null
    });
  }

  /**
   * Clears saved tokens to reset identity configuration contexts
   */
  clearSession(): void {
    localStorage.removeItem('claimit_username');
    localStorage.removeItem('claimit_email');
    localStorage.removeItem('claimit_phone');
    this.userSessionSignal.set(null);
  }
}
