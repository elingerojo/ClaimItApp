import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { AdminAuth } from '../admin-auth/admin-auth';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import {
  buildInviteUrl,
  copyText,
  tryNativeShare,
  buildWhatsAppInviteUrl
} from '../../utils/invite-share';
import { eventStatusLabel } from '../../utils/event-status';
import { deriveEventSchedule } from '@claimitapp/shared';

export interface EventSummary {
  id: string;
  title: string;
  description: string | null;
  /** Fechas v2 del evento (contrato del listado GET /api/events). */
  published_at?: string | null;
  available_from: string;
  claims_close_at?: string | null;
  pickup_deadline: string;
  pickup_schedule_info?: string | null;
  /** Nota markdown de tiempos (solo términos/condiciones; nunca en cálculos). */
  times_notes?: string | null;
  /** Nota markdown de condiciones (solo términos/condiciones; nunca en cálculos). */
  conditions_notes?: string | null;
  status?: string;
  created_at: string;
  /** Nº de items asignados al evento (0 = se puede borrar). */
  item_count?: number;
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

  /** Apodos sugeridos por rol (campo opcional en cada link de invitación). */
  private readonly suggestedApodos = signal<Record<string, string>>({});
  /** Rol elegido en el composer de compartir ('' = sin selección previa). */
  readonly selectedRole = signal<string>('');

  // Form fields (create / edit)
  readonly title = signal('');
  readonly description = signal('');
  readonly pickupScheduleInfo = signal('');
  /** Nota markdown de tiempos (se renderiza en la pestaña Tiempos del detalle). */
  readonly timesNotes = signal('');
  /** Nota markdown de condiciones (se renderiza en la pestaña Condiciones del detalle). */
  readonly conditionsNotes = signal('');
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

  /** Estatus legible del evento (v2) para el listado. */
  readonly eventStatusLabel = eventStatusLabel;

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
    this.selectedRole.set(''); // evita compartir el rol de otro evento
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

  /** Limpia el form para crear: las 4 fechas se sugieren desde la publicación. */
  private resetForm(): void {
    this.title.set('');
    this.description.set('');
    this.pickupScheduleInfo.set('');
    this.timesNotes.set('');
    this.conditionsNotes.set('');
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

  /**
   * Validación de UI del form v2 (mismo criterio que el backend):
   *  - título requerido;
   *  - las 4 fechas presentes y en orden published <= available <= claims_close <= pickup_deadline;
   *  - al CREAR, todas deben quedar en el futuro (requireFuture del backend).
   * Devuelve un mensaje de error o null.
   */
  private validateEventForm(requireFuture: boolean): string | null {
    if (!this.title().trim()) {
      return 'El título del evento es requerido.';
    }
    const parse = (v: string): number | null => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    };
    const pub = parse(this.publishedAt());
    const avail = parse(this.availableFrom());
    const close = parse(this.claimsCloseAt());
    const dl = parse(this.pickupDeadline());
    if (pub == null || avail == null || close == null || dl == null) {
      return 'Las 4 fechas son requeridas: publicación, apertura de apartados, corte de apartados y límite de recogida.';
    }
    if (!(pub <= avail && avail <= close && close <= dl)) {
      return 'Orden inválido de fechas: publicación ≤ apertura ≤ corte de apartados ≤ límite de recogida.';
    }
    if (requireFuture && dl <= Date.now()) {
      return 'Al crear, las fechas deben estar en el futuro (el límite de recogida no puede ser pasado).';
    }
    return null;
  }

  /**
   * Error de fechas en vivo bajo el formulario (solo orden; no molesta con
   * campos vacíos a medio llenar ni exige el título). Devuelve null si no hay
   * problema o si aún faltan fechas por elegir.
   */
  inlineDateError(): string | null {
    const parse = (v: string): number | null => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    };
    const pub = parse(this.publishedAt());
    const avail = parse(this.availableFrom());
    const close = parse(this.claimsCloseAt());
    const dl = parse(this.pickupDeadline());
    if (pub == null || avail == null || close == null || dl == null) return null;
    if (!(pub <= avail && avail <= close && close <= dl)) {
      return 'Orden inválido de fechas: publicación ≤ apertura ≤ corte de apartados ≤ límite de recogida.';
    }
    return null;
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
      this.pickupScheduleInfo.set(ev.pickup_schedule_info ?? '');
      this.timesNotes.set(ev.times_notes ?? '');
      this.conditionsNotes.set(ev.conditions_notes ?? '');
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
    // Payload v2: SOLO las 4 fechas + title/description/pickup_schedule_info +
    // notas markdown de términos/condiciones. CERO columnas por rol: las
    // ventajas se leen en tiempo real de la matriz (advance_pub/disp) y no se
    // congelan en el evento.
    return {
      title: this.title(),
      description: this.description() || null,
      pickup_schedule_info: this.pickupScheduleInfo().trim() || null,
      // Se envían como string (aunque sea '') para que el backend pueda limpiar
      // la nota vía COALESCE; '' oculta el recuadro en el detalle.
      times_notes: this.timesNotes().trim(),
      conditions_notes: this.conditionsNotes().trim(),
      published_at: this.toUtcIsoOrNull(this.publishedAt()),
      available_from: this.toUtcIsoOrNull(this.availableFrom()),
      claims_close_at: this.toUtcIsoOrNull(this.claimsCloseAt()),
      pickup_deadline: this.toUtcIsoOrNull(this.pickupDeadline())
    };
  }

  /** Crea (POST) o actualiza (PATCH) un evento según `editingEventId`. */
  async submit(): Promise<void> {
    const editingId = this.editingEventId();
    // Validación v2 en UI: título + orden de las 4 fechas + futuro al crear.
    const validationError = this.validateEventForm(!editingId);
    if (validationError) {
      this.toastService.error(validationError);
      return;
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
    if (!confirm(`¿Eliminar el evento "${title}"?`)) return;
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

  /** Apodo sugerido (opcional) que se anexará a un link de un rol dado. */
  suggestedApodo(role: string): string {
    return this.suggestedApodos()[role] ?? '';
  }

  setSuggestedApodo(role: string, value: string): void {
    this.suggestedApodos.update(map => ({ ...map, [role]: value.trim() }));
  }

  /** Invitación del rol seleccionado (para el composer de compartir). */
  selectedInvitation(): EventInvitation | null {
    const d = this.detail();
    const role = this.selectedRole();
    if (!d || !role) return null;
    return d.invitations.find(i => i.role === role) ?? null;
  }

  /** Token (código críptico real) de la invitación del rol seleccionado. */
  selectedInvitationCode(): string {
    return this.selectedInvitation()?.code ?? '';
  }

  /** Habilita compartir solo cuando hay rol elegido con invitación activa. */
  canShareSelected(): boolean {
    const inv = this.selectedInvitation();
    return !!inv?.is_active;
  }

  /** Al cambiar el select se guarda el rol elegido. */
  onRoleChange(event: Event): void {
    this.selectedRole.set((event.target as HTMLSelectElement).value);
  }

  /** Escribe el apodo sugerido del rol actualmente seleccionado (campo único). */
  setSelectedRoleApodo(value: string): void {
    const role = this.selectedRole();
    if (!role) return;
    this.setSuggestedApodo(role, value);
  }

  async copyInviteLink(code: string, apodo?: string): Promise<void> {
    const ok = await copyText(buildInviteUrl(code, apodo));
    this.toastService[ok ? 'success' : 'error'](ok ? 'Enlace copiado.' : 'No se pudo copiar.');
  }

  async shareInviteLink(code: string, apodo?: string): Promise<void> {
    const link = buildInviteUrl(code, apodo);
    const shared = await tryNativeShare(link);
    if (!shared) {
      const ok = await copyText(link);
      this.toastService[ok ? 'success' : 'error'](
        ok ? 'Enlace copiado (pégalo en WhatsApp).' : 'No se pudo copiar.'
      );
    }
  }

  whatsAppInviteUrl(code: string, apodo?: string): string {
    return buildWhatsAppInviteUrl(buildInviteUrl(code, apodo));
  }
}
