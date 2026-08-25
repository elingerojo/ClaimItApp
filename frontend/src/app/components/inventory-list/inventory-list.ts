import { Component, signal, computed, inject, effect } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ItemCategory, ItemStatus } from '@claimitapp/shared';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { ItemDetail } from '../item-detail/item-detail';

@Component({
  selector: 'app-inventory-list',
  standalone: true,
  imports: [CommonModule, NgOptimizedImage, StripAccentsPipe, ItemDetail],
  templateUrl: './inventory-list.html'
})
export class InventoryList {
  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);

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
      alert(response.message || '¡Acción registrada con éxito!');
    } catch (err: any) {
      alert(`Error al reclamar: ${err.message}`);
    }
  }

  /**
   * Guarda los datos del usuario resolviendo la sesión contra el servidor.
   * Si hay conflicto de alias, muestra el diálogo correspondiente.
   */
  async onSaveSession(aliasInput: HTMLInputElement, emailInput: HTMLInputElement, phoneInput: HTMLInputElement): Promise<void> {
    const alias = aliasInput.value.trim();
    const email = emailInput.value.trim() || null;
    const phone = phoneInput.value.trim() || null;

    if (!alias) {
      alert('Por favor ingresa un apodo o alias.');
      aliasInput.focus();
      return;
    }

    this.isSaving.set(true);

    try {
      const result = await this.userService.resolveSession(alias, email, phone);

      if (result.conflict && result.storedUuid && result.storedAlias) {
        // Mostrar diálogo de conflicto
        this.conflictData.set({
          alias: result.storedAlias,
          storedUuid: result.storedUuid,
          storedAlias: result.storedAlias,
          email,
          phone
        });
        this.conflictDialogVisible.set(true);
      } else if (result.databaseReset) {
        // BD fue reiniciada desde la última visita del usuario
        alert('La base de datos ha sido reiniciada desde tu última visita. Tus apartados anteriores ya no existen, pero tu identidad se ha conservado. ¡Bienvenido de nuevo!');
      }
      // Si success normal, el UserService ya actualizó el signal
    } catch (err: any) {
      alert(`Error: ${err.message}`);
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

    for (let n = 2; n <= 9; n++) {
      const tocayoAlias = `${baseAlias}-tocayo-${n}`;
      try {
        const result = await this.userService.resolveSession(tocayoAlias, email, phone);
        if (result.success) {
          // Alias tocayo aceptado
          return;
        }
        if (!result.conflict) return; // Error no esperado, salir
      } catch {
        break; // Error de red, salir
      }
    }

    // Si llegamos aquí, todos los tocayo-2..9 están ocupados
    alert(`El alias "${baseAlias}" y sus variantes tocayo están ocupados. Por favor elige un alias completamente diferente.`);
    this.isSaving.set(false);
  }
}
