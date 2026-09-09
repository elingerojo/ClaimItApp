import { Component, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { InventoryService, ItemWithQueue, QueueEntry } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { AdminAuth } from '../admin-auth/admin-auth';
import { ItemDetail } from '../item-detail/item-detail';
import {
  eventStatusBadge,
  eventStatusLabel,
  phaseBadge,
  phaseLabel,
  phaseEmoji,
  claimStateEmoji,
  claimStateLabel
} from '../../utils/event-status';
import { roleDisplayName } from '../../utils/role-info';

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

/** Renglón del calendario congelado (V1..V3 / ventana libre / caridad) en la fila. */
interface TimelineRow {
  key: string;
  label: string;
  icon: string;
  date: string | null;
}

@Component({
  selector: 'app-admin-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, StripAccentsPipe, DateEsPipe, AdminAuth, ItemDetail],
  templateUrl: './admin-manage.html'
})
export class AdminManage {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);

  /** Estatus en orden canónico (para dibujar los chips). */
  readonly statusOptions: EventStatus[] = [...EVENT_STATUS_ORDER];
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;
  /** Bindings de presentación v2 (fase de artículo + claim_state + rol). */
  readonly phaseLabel = phaseLabel;
  readonly phaseBadge = phaseBadge;
  readonly phaseEmoji = phaseEmoji;
  readonly claimStateLabel = claimStateLabel;
  readonly claimStateEmoji = claimStateEmoji;
  readonly roleDisplayName = roleDisplayName;

  /** Combinación activa de estatus (siempre ≥ 1). */
  private readonly activeStatusesSignal = signal<Set<EventStatus>>(new Set([...DEFAULT_ACTIVE_STATUSES]));
  readonly activeStatuses = this.activeStatusesSignal.asReadonly();

  private readonly loadingSignal = signal<boolean>(false);
  readonly loading = this.loadingSignal.asReadonly();

  /** Evita re-disparar la carga mientras ya se arrancó en esta instancia. */
  private bootstrapped = false;

  /** Item abierto en el modal de detalle en modo admin (click en una fila). */
  readonly selectedAdminItem = signal<ItemWithQueue | null>(null);

  // ---------------------------------------------------------------------------
  // Diálogo admin 'Marcar recogido / Entregado' (v2 D6) — POST deliver
  // ---------------------------------------------------------------------------
  /** Item sobre el que se abre el diálogo de entrega. */
  readonly deliverTarget = signal<ItemWithQueue | null>(null);
  /** ¿Diálogo de confirmación de entrega visible? */
  readonly isConfirmingDeliver = signal(false);
  /**
   * claimId elegido para la entrega:
   *  - pickup_turns: se entrega al titular activo (claimId se ignora → null).
   *  - ventana_libre: null = walk-in (sin apartado previo); un id = claim activo.
   */
  readonly deliverClaimId = signal<string | null>(null);
  readonly delivering = signal(false);

  constructor() {
    // Cuando el admin se autentica (puede ocurrir de forma asíncrona tras el
    // mount), restauramos la selección de la sesión y cargamos el inventario
    // filtrado. Al cerrar sesión se limpia el estado local.
    effect(() => {
      const authed = this.adminTokenService.authenticated();
      if (!authed) {
        this.bootstrapped = false;
        this.selectedAdminItem.set(null);
        this.cancelDeliver();
        return;
      }
      if (this.bootstrapped) return;
      this.bootstrapped = true;
      this.activeStatusesSignal.set(new Set(this.readStoredStatuses()));
      void this.reload();
    });

    // Mantiene el item del modal de detalle sincronizado con la lista admin:
    // tras una expulsión (o cualquier mutación SSE) se re-engancha el objeto
    // fresco por id para que la Línea de Espera del modal se actualice en vivo.
    effect(() => {
      const items = this.inventoryService.adminItems();
      const current = this.selectedAdminItem();
      if (!current) return;
      const fresh = items.find((i) => i.id === current.id);
      if (fresh) this.selectedAdminItem.set(fresh);
      else this.selectedAdminItem.set(null);
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

  /** Abre el modal de detalle del objeto en modo admin (con X para expulsar). */
  openAdminDetail(item: ItemWithQueue): void {
    this.selectedAdminItem.set(item);
  }

  /** Cierra el modal de detalle admin. */
  closeAdminDetail(): void {
    this.selectedAdminItem.set(null);
  }

  /** Recorta el título de un evento a ~12 caracteres + puntos suspensivos. */
  truncateEventTitle(title: string | null | undefined, max = 12): string {
    const t = (title ?? '').trim();
    if (!t) return '';
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  // ---------------------------------------------------------------------------
  // Vistas v2 de la cola / calendario congelado por fila
  // ---------------------------------------------------------------------------

  /** Claims ACTIVOS de la cola, ordenados por fifoPosition (nulls last) y luego claimed_at. */
  activeClaimsOf(item: ItemWithQueue): QueueEntry[] {
    const queue = item.queue ?? [];
    return queue
      .filter((c) => c.claimState === 'active')
      .sort((a, b) => {
        const ap = a.fifoPosition ?? Number.MAX_SAFE_INTEGER;
        const bp = b.fifoPosition ?? Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime();
      });
  }

  /** Titular del turno activo (primer claim activo ordenado por posición). */
  activeHolderOf(item: ItemWithQueue): QueueEntry | null {
    return this.activeClaimsOf(item)[0] ?? null;
  }

  /** ¿El admin puede marcar el item como entregado ahora? */
  canDeliver(item: ItemWithQueue): boolean {
    const p = item.phase;
    if (p === 'pickup_turns') return !!this.activeHolderOf(item);
    if (p === 'ventana_libre') return true;
    return false;
  }

  /** ¿Hay calendario congelado (frozen_schedule) para esta fila? */
  hasFrozenCalendar(item: ItemWithQueue): boolean {
    return !!item.frozenSchedule || !!item.temporalState?.linea_tiempo_fija;
  }

  /**
   * Renglones del calendario congelado v2 para la fila admin. El listado admin
   * trae `frozenSchedule` (snapshot raw); el feed público usa temporalState.
   */
  frozenTimelineRows(item: ItemWithQueue): TimelineRow[] {
    const fs = item.frozenSchedule;
    const tl = item.temporalState?.linea_tiempo_fija;
    const rows: TimelineRow[] = [];
    if (fs) {
      rows.push({ key: 'v1', label: 'Turno 1', icon: '👑', date: fs.v1 ?? null });
      rows.push({ key: 'v2', label: 'Turno 2', icon: '⏳', date: fs.v2 ?? null });
      rows.push({ key: 'v3', label: 'Turno 3', icon: '⏳', date: fs.v3 ?? null });
      rows.push({ key: 'ventana', label: 'Ventana libre', icon: '🔥', date: fs.ventana_libre_starts_at ?? null });
      rows.push({ key: 'caridad', label: 'Caridad', icon: '🏁', date: fs.charity_at ?? null });
    } else if (tl) {
      rows.push({ key: 'v1', label: 'Turno 1', icon: '👑', date: tl.vencimiento_posicion_1 ?? null });
      rows.push({ key: 'v2', label: 'Turno 2', icon: '⏳', date: tl.vencimiento_posicion_2 ?? null });
      rows.push({ key: 'v3', label: 'Turno 3', icon: '⏳', date: tl.vencimiento_posicion_3 ?? null });
      rows.push({ key: 'ventana', label: 'Ventana libre', icon: '🔥', date: tl.ventana_libre ?? null });
      rows.push({ key: 'caridad', label: 'Caridad', icon: '🏁', date: tl.caridad_final ?? null });
    }
    return rows.filter((r) => !!r.date);
  }

  // ---------------------------------------------------------------------------
  // Flujo 'Marcar recogido / Entregado' (admin, v2 D6)
  // ---------------------------------------------------------------------------

  /** Abre el diálogo de entrega para un item en pickup_turns / ventana_libre. */
  openDeliver(item: ItemWithQueue): void {
    const active = this.activeClaimsOf(item);
    this.deliverTarget.set(item);
    // Por defecto el claim activo de menor posición (titular / captura de la
    // ventana libre); si no hay activos → null = walk-in.
    this.deliverClaimId.set(active[0]?.id ?? null);
    this.isConfirmingDeliver.set(true);
  }

  cancelDeliver(): void {
    this.isConfirmingDeliver.set(false);
    this.deliverTarget.set(null);
    this.deliverClaimId.set(null);
  }

  /** ¿Muestra el selector de claim en ventana libre? (solo si hay activos). */
  deliverClaimSelectorVisible(): boolean {
    const target = this.deliverTarget();
    return !!target && target.phase === 'ventana_libre' && this.activeClaimsOf(target).length > 0;
  }

  /** Quién recibirá el objeto (texto para el diálogo de confirmación). */
  deliverRecipientLabel(): string {
    const target = this.deliverTarget();
    if (!target) return '';
    const claimId = this.deliverClaimId();
    if (target.phase === 'pickup_turns') {
      const holder = this.activeHolderOf(target);
      return holder ? `@${holder.username ?? 'usuario'}` : '—';
    }
    if (!claimId) return 'Walk-in (sin apartado previo)';
    const claim = (target.queue ?? []).find((q) => q.id === claimId);
    return claim ? `@${claim.username ?? 'usuario'}` : 'Walk-in (sin apartado previo)';
  }

  /** Confirma la entrega: POST /api/admin/items/:id/deliver. */
  async confirmDeliver(): Promise<void> {
    const target = this.deliverTarget();
    const claimId = this.deliverClaimId();
    this.cancelDeliver();
    if (!target) return;
    const token = this.adminTokenService.token();
    if (!token) return;

    this.delivering.set(true);
    try {
      // En pickup_turns la entrega es siempre del titular activo (sin claimId);
      // en ventana_libre se manda el claim elegido o null (walk-in).
      const claimToSend = target.phase === 'ventana_libre' ? claimId : null;
      const res = await this.inventoryService.deliverItem(target.id, token, claimToSend);
      this.toastService.success(
        res?.message || `"${target.title}" quedó marcado como entregado.`
      );
    } catch (err: any) {
      this.toastService.error(`Error al marcar recogido: ${err.message}`);
    } finally {
      this.delivering.set(false);
      // Refresco inmediato de la vista admin (además del SSE debounced).
      this.inventoryService.refreshAdminItems().catch(() => {});
    }
  }
}
