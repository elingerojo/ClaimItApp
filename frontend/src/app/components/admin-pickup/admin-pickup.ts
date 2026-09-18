import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { form, FormField, required } from '@angular/forms/signals';
import type {
  AdminUserSummary,
  AdminPickableItem,
  AdminBatchDeliverResponse
} from '@claimitapp/shared';
import { InventoryService } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { PrecioEsPipe } from '../../pipes/precio-es.pipe';
import { AdminAuth } from '../admin-auth/admin-auth';
import { phaseBadge, phaseEmoji, phaseLabel } from '../../utils/event-status';
import { formatPrecioEs } from '../../utils/precio-es';

/**
 * Registrar entrega (admin) — recepción por usuario.
 *
 * Flujo:
 *  1. Buscar a la persona que llegó (Signal Forms sobre `searchModel`).
 *  2. Cargar los items donde es el titular de MAYOR prioridad de recogida
 *     (claim_open / pickup_turns) o donde capturó un claim en ventana libre.
 *  3. Marcar con checkboxes los objetos que se le entregan.
 *  4. "Registrar entregas" → POST batch que cierra cada item como ENTREGADO.
 *
 * El estado de selección es un `signal<ReadonlySet<string>>` (lista dinámica de
 * checkboxes); Signal Forms se usa para el buscador, que es un control único.
 */
@Component({
  selector: 'app-admin-pickup',
  standalone: true,
  imports: [CommonModule, RouterModule, DateEsPipe, PrecioEsPipe, AdminAuth, FormField],
  templateUrl: './admin-pickup.html'
})
export class AdminPickup {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);

  /** Bindings de presentación de fase (reutilizados de la vista admin). */
  readonly phaseLabel = phaseLabel;
  readonly phaseBadge = phaseBadge;
  readonly phaseEmoji = phaseEmoji;

  // ---------------------------------------------------------------------------
  // Paso 1 — buscador de la persona (Signal Forms)
  // ---------------------------------------------------------------------------
  readonly searchModel = signal('');
  readonly searchForm = form(this.searchModel, (path) => {
    required(path);
  });
  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly results = signal<AdminUserSummary[]>([]);

  // ---------------------------------------------------------------------------
  // Paso 2 — usuario elegido + items recogibles
  // ---------------------------------------------------------------------------
  readonly selectedUser = signal<AdminUserSummary | null>(null);
  readonly loadingItems = signal(false);
  readonly items = signal<AdminPickableItem[]>([]);

  // ---------------------------------------------------------------------------
  // Paso 3 — selección de objetos (checkboxes)
  // ---------------------------------------------------------------------------
  readonly selectedIds = signal<ReadonlySet<string>>(new Set<string>());
  readonly selectedCount = computed(() => this.selectedIds().size);
  readonly allSelected = computed(
    () => this.items().length > 0 && this.selectedIds().size === this.items().length
  );

  /** Items marcados actualmente (para valorar la selección). */
  readonly selectedItems = computed(() =>
    this.items().filter((i) => this.selectedIds().has(i.itemId))
  );
  /** Suma de los precios visibles por rol de los items marcados (sin precio = 0). */
  readonly selectedTotal = computed(() =>
    this.selectedItems().reduce((sum, i) => sum + (i.precioVisible ?? 0), 0)
  );
  /** Items marcados sin precio base (no suman al total). */
  readonly selectedUnpricedCount = computed(
    () => this.selectedItems().filter((i) => i.precioVisible == null).length
  );
  /** True si al menos un item marcado tiene precio (para mostrar el monto). */
  readonly hasSelectedPrice = computed(
    () => this.selectedCount() - this.selectedUnpricedCount() > 0
  );

  // ---------------------------------------------------------------------------
  // Paso 4 — guardado batch
  // ---------------------------------------------------------------------------
  readonly delivering = signal(false);
  readonly lastResults = signal<AdminBatchDeliverResponse | null>(null);

  /** Timer de recarga debounced disparada por el SSE. */
  private pickupReloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Mantiene viva la lista de recogibles: ante cualquier mutación del feed
    // (otro admin entrega, expira un turno, se abre la ventana libre…) se
    // recarga el usuario seleccionado con un pequeño debounce.
    effect(() => {
      const tick = this.inventoryService.pickupTick();
      if (tick === 0) return;
      if (this.pickupReloadTimer !== null) clearTimeout(this.pickupReloadTimer);
      this.pickupReloadTimer = setTimeout(() => {
        this.pickupReloadTimer = null;
        const user = this.selectedUser();
        if (user && !this.delivering()) void this.loadItems(user.uuid);
      }, 600);
    });
  }

  /** Ejecuta la búsqueda de identidad (alias / correo / teléfono). */
  async runSearch(): Promise<void> {
    const token = this.adminTokenService.token();
    if (!token) return;
    this.searching.set(true);
    this.searched.set(true);
    try {
      const users = await this.inventoryService.searchAdminUsers(this.searchModel().trim(), token);
      this.results.set(users);
    } catch (err: any) {
      this.toastService.error(`Error al buscar: ${err.message}`);
    } finally {
      this.searching.set(false);
    }
  }

  /** Elige a la persona y carga sus objetos recogibles. */
  async chooseUser(user: AdminUserSummary): Promise<void> {
    this.selectedUser.set(user);
    this.results.set([]);
    this.searched.set(false);
    this.searchModel.set('');
    this.clearSelection();
    this.lastResults.set(null);
    await this.loadItems(user.uuid);
  }

  /** Vuelve al paso 1 (otra persona). */
  clearUser(): void {
    this.selectedUser.set(null);
    this.items.set([]);
    this.clearSelection();
    this.lastResults.set(null);
  }

  /** Carga (o recarga) los items recogibles del usuario. */
  async loadItems(userUuid: string): Promise<void> {
    const token = this.adminTokenService.token();
    if (!token) return;
    this.loadingItems.set(true);
    try {
      const res = await this.inventoryService.loadAdminPickups(userUuid, token);
      this.items.set(res.items);
      // Conserva solo la selección que siga existiendo tras el refresco.
      const present = new Set(res.items.map((i) => i.itemId));
      this.selectedIds.update((prev) => new Set([...prev].filter((id) => present.has(id))));
    } catch (err: any) {
      this.toastService.error(`No se pudieron cargar los objetos: ${err.message}`);
    } finally {
      this.loadingItems.set(false);
    }
  }

  isSelected(itemId: string): boolean {
    return this.selectedIds().has(itemId);
  }

  toggle(itemId: string): void {
    this.selectedIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  toggleAll(): void {
    if (this.allSelected()) this.clearSelection();
    else this.selectedIds.set(new Set(this.items().map((i) => i.itemId)));
  }

  /** Etiqueta legible del motivo por el que el usuario es el titular. */
  reasonLabel(reason: AdminPickableItem['reason']): string {
    switch (reason) {
      case 'open_claim_first':
        return 'Primero en la lista (apartado abierto, aún sin congelar)';
      case 'turn_holder':
        return 'Titular del turno activo';
      case 'free_window_claim':
        return 'Ventana libre (claim capturado)';
      default:
        return '';
    }
  }

  /** Registra en batch las entregas marcadas y reporta los rechazos. */
  async registerDeliveries(): Promise<void> {
    const user = this.selectedUser();
    const token = this.adminTokenService.token();
    if (!user || !token) return;
    const ids = [...this.selectedIds()];
    if (ids.length === 0) return;

    this.delivering.set(true);
    try {
      const res = await this.inventoryService.deliverBatch(user.uuid, ids, token);
      this.lastResults.set(res);
      const amountSuffix =
        res.totalAmount > 0 ? ` por $${formatPrecioEs(res.totalAmount)}` : '';
      if (res.failedCount === 0) {
        this.toastService.success(`✅ ${res.deliveredCount} objeto(s) entregados${amountSuffix}.`);
      } else if (res.deliveredCount === 0) {
        this.toastService.error(`No se pudo entregar ningún objeto (${res.failedCount} rechazado/s).`);
      } else {
        this.toastService.info(
          `Entregados ${res.deliveredCount}${amountSuffix}; ${res.failedCount} rechazado/s. Revisa el detalle.`
        );
      }
      this.clearSelection();
      await this.loadItems(user.uuid);
    } catch (err: any) {
      this.toastService.error(`Error al registrar las entregas: ${err.message}`);
    } finally {
      this.delivering.set(false);
    }
  }

  private clearSelection(): void {
    this.selectedIds.set(new Set<string>());
  }
}
