import { Component, signal, computed, inject, effect } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { InventoryService, ItemWithQueue, EventSummary } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ToastService } from '../../services/toast';
import { ItemCategory, ItemStatus } from '@claimitapp/shared';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { ItemDetail } from '../item-detail/item-detail';
import { eventStatusBadge, eventStatusLabel } from '../../utils/event-status';

@Component({
  selector: 'app-inventory-list',
  standalone: true,
  imports: [CommonModule, NgOptimizedImage, StripAccentsPipe, DateEsPipe, ItemDetail],
  templateUrl: './inventory-list.html'
})
export class InventoryList {
  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);
  readonly toastService = inject(ToastService);

  // Señal para el item seleccionado en el modal de detalle
  readonly selectedItem = signal<ItemWithQueue | null>(null);

  // Señal para detectar pantalla grande (≥ 1024px)
  readonly isLargeScreen = signal(
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : false
  );

  // Paginación
  readonly currentPage = signal(1);
  readonly pageSize = computed(() => this.isLargeScreen() ? 20 : 10);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredItems().length / this.pageSize()))
  );
  readonly paginatedItems = computed(() => {
    const allItems = this.filteredItems();
    const start = (this.currentPage() - 1) * this.pageSize();
    return allItems.slice(start, start + this.pageSize());
  });

  // Señales reactivas para los nuevos estados de filtrado
  readonly activeCategory = signal<string>('All');
  readonly activeStatus = signal<string>('All');
  readonly showOnlyMyClaims = signal<boolean>(false);

  // ---- Contexto de evento (Fase 1): derivado del feed (eventSummary por item) ----
  /** Eventos presentes en el catálogo con su resumen y nº de objetos. */
  readonly eventContexts = computed(() => {
    const byId = new Map<string, EventSummary & { count: number }>();
    for (const item of this.inventoryService.items()) {
      const ev = item.eventSummary;
      if (!ev) continue;
      const prev = byId.get(ev.id);
      if (prev) prev.count += 1;
      else byId.set(ev.id, { ...ev, count: 1 });
    }
    return [...byId.values()];
  });
  /** Evento seleccionado como filtro (null = todos). */
  readonly selectedEventId = signal<string | null>(null);
  /** Bindings de utilidades de estado de evento para la plantilla. */
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;

  selectEvent(id: string | null): void {
    this.selectedEventId.set(id);
    this.currentPage.set(1);
  }

  // Clases Tailwind para el badge de rol del usuario
  readonly roleBadgeClass = computed(() => {
    const role = this.userService.currentRole();
    return {
      familiares: 'bg-purple-100 text-purple-700',
      amigos: 'bg-blue-100 text-blue-700',
      conocidos: 'bg-gray-100 text-gray-600',
      publico: 'bg-gray-200 text-gray-500'
    }[role] ?? 'bg-gray-100 text-gray-500';
  });

  // Estado del diálogo de conflicto de alias
  readonly conflictDialogVisible = signal(false);
  readonly conflictData = signal<{
    alias: string;
    storedUuid: string;
    storedAlias: string;
    email: string | null;
    phone: string | null;
  } | null>(null);

  // Estado de carga para el botón Guardar
  readonly isSaving = signal(false);

  /**
   * Modo edición de identidad ("Cambiar Alias").
   * Al activarlo NO se borra claimit_uuid del localStorage: conservar el UUID
   * mantiene la identidad y por tanto los apartados previos (comparados por
   * userUuid) siguen visibles, y el servidor toma la ruta de UPDATE (no crea
   * un usuario nuevo ni devuelve databaseReset).
   */
  readonly isEditingIdentity = signal(false);

  constructor() {
    // Detectar cambios de tamaño de ventana en tiempo real
    if (typeof window !== 'undefined') {
      const mql = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mql.matches);
      mql.addEventListener('change', (e) => {
        this.isLargeScreen.set(e.matches);
      });
    }

    // Resetear a página 1 cuando cambian los filtros
    effect(() => {
      this.activeCategory();
      this.activeStatus();
      this.showOnlyMyClaims();
      this.selectedEventId();
      this.currentPage.set(1);
    });

    // Protección: corregir página si excede el total (ocurre al redimensionar)
    effect(() => {
      const max = this.totalPages();
      if (this.currentPage() > max) {
        this.currentPage.set(max);
      }
    });
  }

  readonly categories: ItemCategory[] = [
    'Kitchen', 'Electronics', 'Decor', 'Books', 'Media', 
    'Clothing', 'Bedding', 'Shoes', 'Accessories', 'Bathroom', 
    'Office', 'Utilities', 'Cleaning', 'Sports', 'Misc.'
  ];
  readonly translationMap = {
    Kitchen: "Cocina",
    Electronics: "Electrónica",
    Decor: "Decoración",
    Books: "Libros",
    Media: "Medios",
    Clothing: "Ropa",
    Bedding: "Blancos",
    Shoes: "Zapatos",
    Accessories: "Accesorios",
    Bathroom: "Baño",
    Office: "Oficina",
    Utilities: "Utilería",
    Cleaning: "Limpieza",
    Sports: "Deportes",
    "Misc.": "Varios",
  } as const;

  // Pipeline combinado reactivo para calcular la rejilla en tiempo real
  readonly filteredItems = computed(() => {
    const categoryFilter = this.activeCategory();
    const statusFilter = this.activeStatus();
    const onlyMyClaims = this.showOnlyMyClaims();
    const myUuid = this.userService.currentUuid();
    
    let list = this.inventoryService.items();

    // 0. Filtro por evento (Fase 1): si hay un evento seleccionado, solo sus objetos.
    const eventFilter = this.selectedEventId();
    if (eventFilter) {
      list = list.filter(item => item.eventSummary?.id === eventFilter);
    }

    // 1. Filtrado Prioritario: Mis elegidos (comparado por userUuid)
    if (onlyMyClaims && myUuid) {
      return list.filter(item => 
        item.queue.some(q => q.userUuid === myUuid)
      );
    }

    // 2. Filtrado por Categorías
    if (categoryFilter !== 'All') {
      list = list.filter(item => item.category === categoryFilter);
    }

    // 3. Filtrado por Disponibilidad (ItemStatus)
    if (statusFilter !== 'All') {
      list = list.filter(item => item.status === statusFilter);
    }

    return list;
  });

  goToPage(page: number): void {
    const clamped = Math.max(1, Math.min(page, this.totalPages()));
    this.currentPage.set(clamped);
  }

  closeDetail(): void {
    this.selectedItem.set(null);
  }

  /**
   * Resetea el flag de mis elegidos si se presiona una categoría, para evitar confusiones de UX
   */
  onSelectCategory(cat: string): void {
    this.showOnlyMyClaims.set(false);
    this.activeCategory.set(cat);
  }

  /**
   * Conmutador para el filtro personalizado del usuario
   */
  onToggleMyClaims(): void {
    this.showOnlyMyClaims.update(val => !val);
  }

  /**
   * Verifica si el usuario autenticado ya está en la cola de un objeto
   * Compara por userUuid para precisión (el alias puede cambiar)
   */
  isUserInItemQueue(item: { queue: Array<{ userUuid: string }> }): boolean {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return false;
    return item.queue.some(q => q.userUuid === myUuid);
  }

  /** ¿El usuario autenticado es el primero en la fila de este objeto? */
  isFirstInLine(item: { queue: Array<{ userUuid: string }> }): boolean {
    const myUuid = this.userService.currentUuid();
    return !!myUuid && item.queue.length > 0 && item.queue[0].userUuid === myUuid;
  }

  /** Posición (1-based) del usuario en la fila, o null si no está en ella. */
  myQueuePosition(item: { queue: Array<{ userUuid: string }> }): number | null {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return null;
    const idx = item.queue.findIndex(q => q.userUuid === myUuid);
    return idx >= 0 ? idx + 1 : null;
  }

  async onClaimItem(itemId: string): Promise<void> {
    const userUuid = this.userService.currentUuid();
    const session = this.userService.session();
    if (!userUuid) return;

    try {
      const response = await this.inventoryService.submitClaim(
        itemId,
        userUuid,
        session?.email || null,
        session?.phone || null
      );
      this.toastService.success(response.message || '¡Acción registrada con éxito!');
    } catch (err: any) {
      this.toastService.error(`Error al reclamar: ${err.message}`);
    }
  }

  /**
   * Abre el modo edición de identidad ("Cambiar Alias").
   * NO borra claimit_uuid del localStorage: conserva el UUID (identidad) y por
   * tanto los apartados previos; el guardado posterior toma la ruta UPDATE en
   * el servidor (sin databaseReset ni alta de usuario nuevo).
   */
  beginAliasEdit(): void {
    this.isEditingIdentity.set(true);
  }

  /**
   * Cancela el modo edición de identidad y regresa al badge de sesión.
   */
  cancelAliasEdit(): void {
    this.isEditingIdentity.set(false);
  }

  /**
   * Guarda los datos del usuario resolviendo la sesión contra el servidor.
   * Si hay conflicto de alias, muestra el diálogo correspondiente.
   * Con la identidad conservada (mismo UUID) el servidor actualiza el alias en
   * lugar de crear un usuario nuevo, así que no se emite databaseReset.
   */
  async onSaveSession(aliasInput: HTMLInputElement, emailInput: HTMLInputElement, phoneInput: HTMLInputElement): Promise<void> {
    const alias = aliasInput.value.trim();
    const email = emailInput.value.trim() || null;
    const phone = phoneInput.value.trim() || null;

    if (!alias) {
      this.toastService.error('Por favor ingresa un apodo o alias.');
      aliasInput.focus();
      return;
    }

    this.isSaving.set(true);

    try {
      const result = await this.userService.resolveSession(alias, email, phone);

      if (result.conflict && result.storedUuid && result.storedAlias) {
        // Mostrar diálogo de conflicto; se mantiene el modo edición abierto
        this.conflictData.set({
          alias: result.storedAlias,
          storedUuid: result.storedUuid,
          storedAlias: result.storedAlias,
          email,
          phone
        });
        this.conflictDialogVisible.set(true);
        return;
      }

      // Éxito: sesión resuelta (con el mismo UUID si el usuario ya existía).
      // Cerrar el modo edición y refrescar para reflejar el alias en las colas.
      this.isEditingIdentity.set(false);

      if (result.databaseReset) {
        // BD fue reiniciada desde la última visita del usuario (caso real de migración)
        this.toastService.info('La base de datos ha sido reiniciada desde tu última visita. Tus apartados anteriores ya no existen, pero tu identidad se ha conservado. ¡Bienvenido de nuevo!');
      }

      this.inventoryService.refresh().catch(() => {});
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * El usuario elige continuar con el alias existente (nuevo dispositivo)
   */
  onAcceptConflictAlias(): void {
    const data = this.conflictData();
    if (!data) return;

    this.userService.acceptServerUuid(data.storedUuid, data.storedAlias, data.email, data.phone);
    this.confirmDialogHidden();
    this.isEditingIdentity.set(false);
    this.inventoryService.refresh().catch(() => {});
  }

  /**
   * El usuario elige elegir otro alias
   */
  onRejectConflictAlias(): void {
    this.confirmDialogHidden();
    // Focus en el input de alias después de cerrar el diálogo
    setTimeout(() => {
      const aliasInput = document.querySelector<HTMLInputElement>('input[placeholder="Apodo o alias"]');
      aliasInput?.focus();
      aliasInput?.select();
    }, 100);
  }

  private confirmDialogHidden(): void {
    this.conflictDialogVisible.set(false);
    this.conflictData.set(null);
  }

  /**
   * Intenta variantes tocoyo-N cuando hay conflicto de alias.
   * Usa los datos almacenados en conflictData().
   * Empieza en 2 (el 1 es el alias original).
   */
  async onTryTocayoFromDialog(): Promise<void> {
    const data = this.conflictData();
    if (!data) return;

    const baseAlias = data.storedAlias;
    const email = data.email;
    const phone = data.phone;

    this.isSaving.set(true);
    this.confirmDialogHidden();

    try {
      for (let n = 2; n <= 9; n++) {
        const tocayoAlias = `${baseAlias}-tocayo-${n}`;
        const result = await this.userService.resolveSession(tocayoAlias, email, phone);
        if (result.success) {
          // Alias tocayo aceptado
          this.isEditingIdentity.set(false);
          this.inventoryService.refresh().catch(() => {});
          return;
        }
        if (!result.conflict) break; // Error no esperado, salir
      }

      // Si llegamos aquí, todos los tocayo-2..9 están ocupados
      this.toastService.error(`El alias "${baseAlias}" y sus variantes tocayo están ocupados. Por favor elige un alias completamente diferente.`);
    } catch {
      // Error de red: salir dejando el modo edición abierto para reintentar
    } finally {
      this.isSaving.set(false);
    }
  }
}
