import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { InventoryService } from '../../services/inventory';
import { UserService } from '../../services/user';
import { railwayApiUrl } from '../../app.config';
import { AdminAuth } from '../admin-auth/admin-auth';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import {
  buildInviteUrl,
  copyText,
  tryNativeShare,
  buildWhatsAppInviteUrl
} from '../../utils/invite-share';

export interface EventSummary {
  id: string;
  owner_uuid: string;
  title: string;
  description: string | null;
  available_from: string;
  pickup_deadline: string;
  created_at: string;
}

export interface EventInvitation {
  role: string;
  code: string;
  use_count: number;
  is_active: boolean;
  created_at: string;
}

export interface EventDetail {
  event: any;
  items: any[];
  members: any[];
  invitations: EventInvitation[];
}

@Component({
  selector: 'app-admin-events',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, AdminAuth, DateEsPipe],
  templateUrl: './admin-events.html'
})
export class AdminEvents {
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);
  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);

  private readonly apiUrl = railwayApiUrl;

  readonly events = signal<EventSummary[]>([]);
  readonly detail = signal<EventDetail | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly formVisible = signal(false);
  readonly assignPanelId = signal<string | null>(null);
  readonly selectedItemIds = signal<string[]>([]);

  // Form fields (create)
  readonly ownerUuid = signal('');
  readonly title = signal('');
  readonly description = signal('');
  readonly availableFrom = signal('');
  readonly pickupDeadline = signal('');
  readonly claimsCloseAt = signal('');
  readonly publishedAt = signal('');
  readonly familiaresAdvance = signal<number>(72);
  readonly amigosAdvance = signal<number>(24);
  readonly conocidosAdvance = signal<number>(0);
  readonly familiaresShare = signal<number>(6);
  readonly amigosShare = signal<number>(4);
  readonly conocidosShare = signal<number>(2);
  readonly familiaresPickup = signal<number | null>(48);
  readonly amigosPickup = signal<number | null>(36);
  readonly conocidosPickup = signal<number | null>(24);
  readonly publicoPickup = signal<number | null>(12);

  readonly roleLabels: Record<string, string> = {
    familiares: '👨‍👩‍👧‍👦 Familiares',
    amigos: '🤝 Amigos',
    conocidos: '👋 Conocidos',
    publico: '🌐 Público'
  };

  async loadEvents(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await fetch(`${this.apiUrl}/events`);
      const data = await res.json();
      this.events.set(data.events ?? []);
    } catch (err: any) {
      this.toastService.error(`Error al cargar eventos: ${err.message}`);
    } finally {
      this.loading.set(false);
    }
  }

  async openDetail(id: string): Promise<void> {
    this.detail.set(null);
    try {
      const res = await fetch(`${this.apiUrl}/admin/events/${id}`, {
        headers: { 'X-Admin-Token': this.adminTokenService.token() }
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No autorizado');
      this.detail.set(await res.json());
    } catch (err: any) {
      this.toastService.error(`Error al cargar detalle: ${err.message}`);
    }
  }

  toggleForm(): void {
    this.formVisible.update(v => !v);
    // Pre-llenar el owner con la sesión de usuario actual si existe
    if (!this.ownerUuid()) this.ownerUuid.set(this.userService.currentUuid());
  }

  async submitCreate(): Promise<void> {
    if (!this.title() || !this.availableFrom() || !this.pickupDeadline() || !this.ownerUuid()) {
      this.toastService.error('Título, owner UUID, fecha disponible y fecha límite son requeridos.');
      return;
    }
    this.saving.set(true);
    try {
      const res = await fetch(`${this.apiUrl}/admin/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({
          userUuid: this.ownerUuid(),
          title: this.title(),
          description: this.description() || null,
          available_from: new Date(this.availableFrom()).toISOString(),
          pickup_deadline: new Date(this.pickupDeadline()).toISOString(),
          claims_close_at: this.claimsCloseAt() ? new Date(this.claimsCloseAt()).toISOString() : null,
          published_at: this.publishedAt() ? new Date(this.publishedAt()).toISOString() : null,
          familiares_advance_hours: this.familiaresAdvance(),
          amigos_advance_hours: this.amigosAdvance(),
          conocidos_advance_hours: this.conocidosAdvance(),
          familiares_share_bonus: this.familiaresShare(),
          amigos_share_bonus: this.amigosShare(),
          conocidos_share_bonus: this.conocidosShare(),
          familiares_pickup_hours: this.familiaresPickup() ?? null,
          amigos_pickup_hours: this.amigosPickup() ?? null,
          conocidos_pickup_hours: this.conocidosPickup() ?? null,
          publico_pickup_hours: this.publicoPickup() ?? null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al crear evento');
      this.toastService.success('Evento creado con 4 links de invitación.');
      this.formVisible.set(false);
      this.title.set('');
      this.description.set('');
      this.availableFrom.set('');
      this.pickupDeadline.set('');
      this.claimsCloseAt.set('');
      this.publishedAt.set('');
      this.familiaresAdvance.set(72);
      this.amigosAdvance.set(24);
      this.conocidosAdvance.set(0);
      this.familiaresShare.set(6);
      this.amigosShare.set(4);
      this.conocidosShare.set(2);
      this.familiaresPickup.set(48);
      this.amigosPickup.set(36);
      this.conocidosPickup.set(24);
      this.publicoPickup.set(12);
      await this.loadEvents();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.saving.set(false);
    }
  }

  async removeEvent(id: string, title: string): Promise<void> {
    if (!confirm(`¿Eliminar el evento "${title}"? Los items quedan sin evento.`)) return;
    try {
      const res = await fetch(`${this.apiUrl}/admin/events/${id}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Token': this.adminTokenService.token() }
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Error al eliminar');
      this.toastService.success('Evento eliminado.');
      this.detail.set(null);
      await this.loadEvents();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }

  toggleAssign(id: string): void {
    this.assignPanelId.update(v => (v === id ? null : id));
    this.selectedItemIds.set([]);
  }

  toggleItemSelection(itemId: string): void {
    this.selectedItemIds.update(list =>
      list.includes(itemId) ? list.filter(x => x !== itemId) : [...list, itemId]
    );
  }

  async submitAssign(id: string): Promise<void> {
    if (this.selectedItemIds().length === 0) {
      this.toastService.error('Selecciona al menos un item.');
      return;
    }
    try {
      const res = await fetch(`${this.apiUrl}/admin/events/${id}/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({ itemIds: this.selectedItemIds() })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Error al asignar');
      this.toastService.success(`${this.selectedItemIds().length} item(s) asignados.`);
      this.assignPanelId.set(null);
      this.inventoryService.refresh().catch(() => {});
      await this.openDetail(id);
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }

  /** Enlace completo compartible: HOME + token (https://SITIO/?invite=CODE). */
  inviteUrl(code: string): string {
    return buildInviteUrl(code);
  }

  async copyInviteLink(code: string): Promise<void> {
    const ok = await copyText(buildInviteUrl(code));
    this.toastService[ok ? 'success' : 'error'](ok ? 'Enlace copiado.' : 'No se pudo copiar.');
  }

  async shareInviteLink(code: string): Promise<void> {
    const link = buildInviteUrl(code);
    const shared = await tryNativeShare(link);
    if (!shared) {
      const ok = await copyText(link);
      this.toastService[ok ? 'success' : 'error'](
        ok ? 'Enlace copiado (pégalo en WhatsApp).' : 'No se pudo copiar.'
      );
    }
  }

  whatsAppInviteUrl(code: string): string {
    return buildWhatsAppInviteUrl(buildInviteUrl(code));
  }
}
