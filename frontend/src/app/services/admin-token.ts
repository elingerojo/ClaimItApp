import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AdminTokenService {
  readonly token = signal<string>('');
  readonly tokenAccepted = signal<boolean>(false);
  private tokenAcceptedTimer: ReturnType<typeof setTimeout> | null = null;

  setToken(val: string): void {
    this.token.set(val);
  }

  onTokenEnter(inputEl: HTMLInputElement): void {
    inputEl.blur(); // Dismiss mobile keyboard

    if (!this.token()) return;

    this.tokenAccepted.set(true);

    if (this.tokenAcceptedTimer) clearTimeout(this.tokenAcceptedTimer);
    this.tokenAcceptedTimer = setTimeout(() => {
      this.tokenAccepted.set(false);
      this.tokenAcceptedTimer = null;
    }, 2000);
  }
}
