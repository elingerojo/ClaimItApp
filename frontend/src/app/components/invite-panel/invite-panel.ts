import { Component, inject, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UserService } from '../../services/user';
import { InventoryService, EventSummary } from '../../services/inventory';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import {
  buildInviteUrl,
  copyText,
  tryNativeShare,
  buildWhatsAppInviteUrl
} from '../../utils/invite-share';

interface EventContext extends EventSummary {
  count: number;
}

/**
 * Footer de invitación para usuarios NO administradores, al mero final de la
 * página principal. Cada participante ve UN solo enlace (el siguiente escalón
 * que el servidor le permite compartir) con CTA neutro: la jerarquía de roles
 * nunca se muestra.
 */
@Component({
  selector: 'app-invite-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './invite-panel.html'
})
export class InvitePanel {
  private readonly userService = inject(UserService);
  private readonly inventoryService = inject(InventoryService);
  private readonly toastService = inject(ToastService);
  private readonly apiUrl = railwayApiUrl;

  /** Eventos presentes en el catálogo con su nº de objetos. */
  readonly events = computed<EventContext[]>(() => {
    const byId = new Map<string, EventContext>();
    for (const item of this.inventoryService.items()) {
      const ev = item.eventSummary;
      if (!ev) continue;
      const prev = byId.get(ev.id);
      if (prev) prev.count += 1;
      else byId.set(ev.id, { ...ev, count: 1 });
    }
    return [...byId.values()];
  });

  /** Visible: sesión activa, rol no público y al menos un evento en el catálogo. */
  readonly visible = computed(() => {
    const evs = this.events();
    return (
      this.userService.isAuthenticated() &&
      this.userService.currentRole() !== 'publico' &&
      evs.length > 0
    );
  });

  readonly selectedEventId = signal<string>('');
  readonly link = signal<string | null>(null);
  readonly loading = signal(false);

  /** Evento seleccionado (o el único cuando no hay selección explícita). */
  readonly selectedEvent = computed<EventContext | null>(() => {
    const evs = this.events();
    if (evs.length === 0) return null;
    const sel = this.selectedEventId();
    return (sel ? evs.find(e => e.id === sel) : undefined) ?? evs[0];
  });

  isCurrent(id: string): boolean {
    return this.selectedEvent()?.id === id;
  }

  selectEvent(id: string): void {
    this.selectedEventId.set(id);
    this.link.set(null);
  }

  async generateLink(): Promise<void> {
    const ev = this.selectedEvent();
    const uuid = this.userService.currentUuid();
    if (!ev || !uuid || this.loading()) return;
    this.loading.set(true);
    try {
      // El servidor decide el siguiente escalón según el rol del usuario.
      const res = await fetch(
        `${this.apiUrl}/events/${ev.id}/share-link?userUuid=${encodeURIComponent(uuid)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo generar el enlace.');
      this.link.set(buildInviteUrl(data.code));
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.loading.set(false);
    }
  }

  async copy(): Promise<void> {
    const link = this.link();
    if (!link) return;
    const ok = await copyText(link);
    this.toastService[ok ? 'success' : 'error'](ok ? 'Enlace copiado.' : 'No se pudo copiar.');
  }

  async share(): Promise<void> {
    const link = this.link();
    if (!link) return;
    const shared = await tryNativeShare(link);
    if (!shared) {
      const ok = await copyText(link);
      this.toastService[ok ? 'success' : 'error'](
        ok ? 'Enlace copiado (pégalo en WhatsApp).' : 'No se pudo copiar.'
      );
    }
  }

  whatsAppUrl(): string {
    const link = this.link();
    return link ? buildWhatsAppInviteUrl(link) : '#';
  }
}
