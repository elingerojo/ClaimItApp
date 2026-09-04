import { Component, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { InventoryService } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { AdminAuth } from '../admin-auth/admin-auth';
import { eventStatusBadge, eventStatusLabel } from '../../utils/event-status';

/** Orden canónico de estatus de evento (mismo orden que EVENT_STATUSES del backend). */
const EVENT_STATUS_ORDER = ['draft', 'scheduled', 'active', 'closing', 'closed'] as const;
type EventStatus = (typeof EVENT_STATUS_ORDER)[number];

/**
 * Arranque por defecto: los estatus "vivos" activos; `closed` queda APAGADO.
 * Así el caso común no arrastra el histórico de eventos cerrados (anti-acumulación)
 * y `closed` solo se consulta bajo demanda.
 */
const DEFAULT_ACTIVE_STATUSES: readonly EventStatus[] = ['draft', 'scheduled', 'active', 'closing'];

/** Clave de persistencia de la selección dentro de la sesión. */
const FILTER_STORAGE_KEY = 'claimit_admin_event_status_filter';

@Component({
  selector: 'app-admin-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, StripAccentsPipe, DateEsPipe, AdminAuth],
  templateUrl: './admin-manage.html'
})
export class AdminManage {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);

  private readonly apiUrl = railwayApiUrl;

  /** Estatus en orden canónico (para dibujar los chips). */
  readonly statusOptions: EventStatus[] = [...EVENT_STATUS_ORDER];
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;

  /** Combinación activa de estatus (siempre ≥ 1). */
  private readonly activeStatusesSignal = signal<Set<EventStatus>>(new Set([...DEFAULT_ACTIVE_STATUSES]));
  readonly activeStatuses = this.activeStatusesSignal.asReadonly();

  private readonly loadingSignal = signal<boolean>(false);
  readonly loading = this.loadingSignal.asReadonly();

  /** Evita re-disparar la carga mientras ya se arrancó en esta instancia. */
  private bootstrapped = false;

  constructor() {
    // Cuando el admin se autentica (puede ocurrir de forma asíncrona tras el
    // mount), restauramos la selección de la sesión y cargamos el inventario
    // filtrado. Al cerrar sesión se limpia el estado local.
    effect(() => {
      const authed = this.adminTokenService.authenticated();
      if (!authed) {
        this.bootstrapped = false;
        return;
      }
      if (this.bootstrapped) return;
      this.bootstrapped = true;
      this.activeStatusesSignal.set(new Set(this.readStoredStatuses()));
      void this.reload();
    });
  }

  /** ¿Está activo (filtrando) el estatus? */
  isActive(status: EventStatus): boolean {
    return this.activeStatuses().has(status);
  }

  /** Total de items de ese estatus (conteo del servidor, incluye inactivos). */
  countFor(status: EventStatus): number {
    return this.inventoryService.adminCounts()[status] ?? 0;
  }

  /** Clases Tailwind del chip según esté activo o inactivo. */
  chipClass(status: EventStatus): string {
    if (!this.isActive(status)) {
      return 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50';
    }
    const active: Record<EventStatus, string> = {
      draft: 'bg-gray-700 border-gray-700 text-white',
      scheduled: 'bg-blue-600 border-blue-600 text-white',
      active: 'bg-green-600 border-green-600 text-white',
      closing: 'bg-amber-500 border-amber-500 text-white',
      closed: 'bg-red-600 border-red-600 text-white'
    };
    return active[status];
  }

  /** Texto de ayuda del chip para el tooltip. */
  chipTitle(status: EventStatus): string {
    const count = this.countFor(status);
    return this.isActive(status)
      ? `Mostrando objetos de eventos ${this.eventStatusLabel(status)} (${count}). Click para ocultarlos.`
      : `Ocultando objetos de eventos ${this.eventStatusLabel(status)} (${count}). Click para mostrarlos.`;
  }

  /**
   * Alterna un chip:
   * - Inactivo → se activa (se suma a la combinación).
   * - Activo con >1 activo → se desactiva.
   * - Único activo → NO puede quedar en 0: se desactiva el clicado y se activa
   *   el SIGUIENTE del orden canónico; si el siguiente se derrama al final de
   *   la lista, vuelve al primero (lista circular).
   */
  toggleStatus(status: EventStatus): void {
    const current = this.activeStatuses();
    const next = new Set(current);

    if (!next.has(status)) {
      next.add(status);
    } else if (next.size > 1) {
      next.delete(status);
    } else {
      // Es el único activo y el usuario intenta desactivarlo: mínimo 1.
      const idx = this.statusOptions.indexOf(status);
      const nextStatus = this.statusOptions[(idx + 1) % this.statusOptions.length];
      next.delete(status);
      next.add(nextStatus);
    }

    this.applyStatuses(next);
  }

  /** Restablece a los estatus "vivos" (borrador, próximo, activo, en recolección). */
  resetToLive(): void {
    this.applyStatuses(new Set(DEFAULT_ACTIVE_STATUSES));
  }

  private applyStatuses(statuses: ReadonlySet<EventStatus>): void {
    this.activeStatusesSignal.set(new Set(statuses));
    this.writeStoredStatuses(statuses);
    void this.reload();
  }

  /** Recarga la tabla admin con la combinación de estatus actual. */
  async reload(): Promise<void> {
    const token = this.adminTokenService.token();
    const active = this.activeStatuses();
    const statuses = EVENT_STATUS_ORDER.filter((s) => active.has(s));
    if (!token || statuses.length === 0) return;

    this.loadingSignal.set(true);
    try {
      await this.inventoryService.loadAdminItems(statuses, token);
    } catch (err: any) {
      this.toastService.error(`Error al cargar el inventario: ${err.message}`);
    } finally {
      this.loadingSignal.set(false);
    }
  }

  private readStoredStatuses(): EventStatus[] {
    if (typeof sessionStorage === 'undefined') return [...DEFAULT_ACTIVE_STATUSES];
    try {
      const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
      if (!raw) return [...DEFAULT_ACTIVE_STATUSES];
      const parsed: string[] = JSON.parse(raw);
      const valid = parsed.filter(
        (s): s is EventStatus => (EVENT_STATUS_ORDER as readonly string[]).includes(s)
      );
      return valid.length > 0 ? valid : [...DEFAULT_ACTIVE_STATUSES];
    } catch {
      return [...DEFAULT_ACTIVE_STATUSES];
    }
  }

  private writeStoredStatuses(statuses: ReadonlySet<EventStatus>): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      const arr = EVENT_STATUS_ORDER.filter((s) => statuses.has(s));
      sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(arr));
    } catch {
      // Sin persistencia disponible: la selección sigue activa en memoria.
    }
  }

  async handleDeleteItem(itemId: string, title: string): Promise<void> {
    const confirmation = confirm(`¿Estás seguro de que deseas eliminar "${title}"? Esta acción no se puede deshacer.`);
    if (!confirmation) return;

    try {
      await this.inventoryService.deleteItem(itemId, this.adminTokenService.token());
      this.toastService.success('¡Objeto eliminado con éxito!');
      // Refresco inmediato (además del SSE debounced) para reflejar el cambio.
      void this.reload();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }

  async handleEviction(itemId: string, username: string): Promise<void> {
    const confirmation = confirm(`¿Estás seguro de que deseas expulsar a @${username}?`);
    if (!confirmation) return;

    try {
      const res = await fetch(`${this.apiUrl}/admin/evict`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({ itemId, username })
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error en la expulsión.');
      this.toastService.success('¡Línea actualizada con éxito!');
      void this.reload();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }

  /** Recorta el título de un evento a ~12 caracteres + puntos suspensivos. */
  truncateEventTitle(title: string | null | undefined, max = 12): string {
    const t = (title ?? '').trim();
    if (!t) return '';
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }
}
