import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { InventoryService } from '../../services/inventory';
import { railwayApiUrl } from '../../app.config';
import { AdminAuth } from '../admin-auth/admin-auth';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import {
  buildInviteUrl,
  copyText,
  tryNativeShare,
  buildWhatsAppInviteUrl
} from '../../utils/invite-share';
import { deriveEventSchedule } from '@claimitapp/shared';

export interface EventSummary {
  id: string;
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

/** Huecos de agenda para derivar las fechas públicas desde la publicación. */
export interface AgendaInput {
  open_after_publish_hours: number;
  claims_window_hours: number;
  closing_window_hours: number;
}

/** Agenda por defecto si la configuración (migración 012) aún no existe. */
const DEFAULT_AGENDA: AgendaInput = {
  open_after_publish_hours: 24,
  claims_window_hours: 72,
  closing_window_hours: 48
};

@Component({
  selector: 'app-admin-events',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, AdminAuth, DateEsPipe],
  templateUrl: './admin-events.html'
})
export class AdminEvents implements OnInit, OnDestroy {
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);
  readonly inventoryService = inject(InventoryService);
  private readonly route = inject(ActivatedRoute);
  private querySub?: Subscription;

  private readonly apiUrl = railwayApiUrl;

  readonly events = signal<EventSummary[]>([]);
  readonly detail = signal<EventDetail | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly formVisible = signal(false);
  /** Evento en edición (null = modo crear). */
  readonly editingEventId = signal<string | null>(null);
  readonly assignPanelId = signal<string | null>(null);
  readonly selectedItemIds = signal<string[]>([]);

  // Form fields (create / edit)
  readonly title = signal('');
  readonly description = signal('');
  readonly availableFrom = signal('');
  readonly pickupDeadline = signal('');
  readonly claimsCloseAt = signal('');
  readonly publishedAt = signal('');

  /** Agenda global (event_config) para derivar fechas desde la publicación. */
  readonly agenda = signal<AgendaInput>(DEFAULT_AGENDA);
  private agendaLoaded = false;

  readonly roleLabels: Record<string, string> = {
    familiares: '👨‍👩‍👧‍👦 Familiares',
    amigos: '🤝 Amigos',
    conocidos: '👋 Conocidos',
    publico: '🌐 Público'
  };

  ngOnInit(): void {
    // Auto-carga la lista al entrar (antes quedaba vacía hasta pulsar
    // "Refrescar") y, si llegamos con ?open=EVENT_ID (enlace desde Gestionar
    // Inventario), abre automáticamente el panel Detalle de ese evento.
    this.querySub = this.route.queryParamMap.subscribe(async (params) => {
      const openId = params.get('open');
      await this.loadEvents();

      if (openId && this.adminTokenService.authenticated() && this.events().some(ev => ev.id === openId)) {
        await this.openDetail(openId);
      }
    });
  }

  ngOnDestroy(): void {
    this.querySub?.unsubscribe();
  }

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

  async toggleForm(): Promise<void> {
    if (this.formVisible()) {
      // Cerrar el form (create o edit)
      this.formVisible.set(false);
      this.editingEventId.set(null);
      return;
    }
    // Modo crear: cargar la agenda de la configuración (una sola vez) y
    // precargar el form derivado desde la fecha de publicación.
    await this.loadAgendaIfNeeded();
    this.resetForm();
    this.formVisible.set(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Limpia el form para crear: la fecha de publicación es la única editable. */
  private resetForm(): void {
    this.title.set('');
    this.description.set('');
    this.editingEventId.set(null);
    // Ancla por defecto = mañana a la misma hora; deriva el resto.
    const pub = this.toLocalInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    this.publishedAt.set(pub);
    this.recomputeDerivedFromPublish();
  }

  /** ISO (UTC) → valor para un <input type="datetime-local"> (local). */
  private toLocalInputValue(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Valor datetime-local → ISO (UTC), o null si viene vacío. */
  private toUtcIsoOrNull(value: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** Carga la agenda global (GET /api/admin/event-config) una sola vez. */
  private async loadAgendaIfNeeded(): Promise<void> {
    if (this.agendaLoaded) return;
    this.agendaLoaded = true;
    try {
      const res = await fetch(`${this.apiUrl}/admin/event-config`, {
        headers: { 'X-Admin-Token': this.adminTokenService.token() }
      });
      if (!res.ok) return; // migración 012 sin aplicar → se usan los defaults
      const data = await res.json();
      const c = data.config ?? {};
      this.agenda.set({
        open_after_publish_hours: Number(c.open_after_publish_hours),
        claims_window_hours: Number(c.claims_window_hours),
        closing_window_hours: Number(c.closing_window_hours)
      });
    } catch {
      // Error de red: usar defaults.
    }
  }

  /** Recalcula las 3 fechas derivadas desde la fecha de publicación. */
  private recomputeDerivedFromPublish(): void {
    const pub = this.publishedAt();
    if (!pub) {
      this.availableFrom.set('');
      this.claimsCloseAt.set('');
      this.pickupDeadline.set('');
      return;
    }
    const d = new Date(pub);
    if (Number.isNaN(d.getTime())) return;
    const agenda = this.agenda();
    const sched = deriveEventSchedule(
      {
        open_after_publish_hours: agenda.open_after_publish_hours,
        claims_window_hours: agenda.claims_window_hours,
        closing_window_hours: agenda.closing_window_hours
      },
      d
    );
    this.availableFrom.set(this.toLocalInputValue(sched.available_from.toISOString()));
    this.claimsCloseAt.set(this.toLocalInputValue(sched.claims_close_at.toISOString()));
    this.pickupDeadline.set(this.toLocalInputValue(sched.pickup_deadline.toISOString()));
  }

  /** Al cambiar la fecha de publicación (modo crear) se re-derivan las fechas. */
  onPublishedChange(): void {
    if (this.editingEventId()) return; // al editar un evento no se re-deriva
    this.recomputeDerivedFromPublish();
  }

  /** Abre el formulario precargado con los datos del evento para editarlo. */
  async editEvent(id: string): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/admin/events/${id}`, {
        headers: { 'X-Admin-Token': this.adminTokenService.token() }
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No autorizado');
      const data = await res.json();
      const ev = data.event;

      this.title.set(ev.title ?? '');
      this.description.set(ev.description ?? '');
      this.availableFrom.set(this.toLocalInputValue(ev.available_from));
      this.pickupDeadline.set(this.toLocalInputValue(ev.pickup_deadline));
      this.claimsCloseAt.set(this.toLocalInputValue(ev.claims_close_at));
      this.publishedAt.set(this.toLocalInputValue(ev.published_at));

      this.editingEventId.set(id);
      this.formVisible.set(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      this.toastService.error(`Error al cargar el evento para editar: ${err.message}`);
    }
  }

  private buildPayload(): Record<string, any> {
    // Las ventajas por rol (advance/bonus/pickup) NO se envían: el backend las
    // congela desde la matriz de confianza al crear y el PATCH las conserva.
    return {
      title: this.title(),
      description: this.description() || null,
      available_from: this.toUtcIsoOrNull(this.availableFrom()),
      pickup_deadline: this.toUtcIsoOrNull(this.pickupDeadline()),
      claims_close_at: this.toUtcIsoOrNull(this.claimsCloseAt()),
      published_at: this.toUtcIsoOrNull(this.publishedAt())
    };
  }

  /** Crea (POST) o actualiza (PATCH) un evento según `editingEventId`. */
  async submit(): Promise<void> {
    const editingId = this.editingEventId();
    if (!this.title()) {
      this.toastService.error('El título del evento es requerido.');
      return;
    }
    if (editingId) {
      if (!this.availableFrom() || !this.pickupDeadline()) {
        this.toastService.error('Fecha disponible y fecha límite de recogida son requeridas.');
        return;
      }
    } else {
      // Modo crear: la fecha de publicación es la ancla; el resto se calcula.
      if (!this.publishedAt() || !this.availableFrom() || !this.pickupDeadline()) {
        this.toastService.error('Elige la fecha de publicación (las demás se calculan).');
        return;
      }
    }
    this.saving.set(true);
    try {
      const res = await fetch(
        editingId ? `${this.apiUrl}/admin/events/${editingId}` : `${this.apiUrl}/admin/events`,
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': this.adminTokenService.token()
          },
          body: JSON.stringify(this.buildPayload())
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.error || (editingId ? 'Error al actualizar evento' : 'Error al crear evento')
        );
      }
      this.toastService.success(
        editingId ? 'Evento actualizado.' : 'Evento creado con 4 links de invitación.'
      );
      this.formVisible.set(false);
      this.resetForm();
      await this.loadEvents();
      if (editingId && this.detail()?.event?.id === editingId) {
        await this.openDetail(editingId);
      }
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
