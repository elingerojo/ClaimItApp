import { Component, signal, computed, inject, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ItemCategory, ItemStatus } from '@claimitapp/shared';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { ItemDetail } from '../item-detail/item-detail';

@Component({
  selector: 'app-inventory-list',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe, ItemDetail],
  templateUrl: './inventory-list.html'
})
export class InventoryList {
  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);

  // Señal para el item seleccionado en el modal de detalle
  readonly selectedItem = signal<ItemWithQueue | null>(null);

  // Paginación
  readonly currentPage = signal(1);
  readonly pageSize = 10;
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredItems().length / this.pageSize))
  );
  readonly paginatedItems = computed(() => {
    const allItems = this.filteredItems();
    const start = (this.currentPage() - 1) * this.pageSize;
    return allItems.slice(start, start + this.pageSize);
  });

  // Señales reactivas para los nuevos estados de filtrado
  readonly activeCategory = signal<string>('All');
  readonly activeStatus = signal<string>('All');
  readonly showOnlyMyClaims = signal<boolean>(false);

  constructor() {
    effect(() => {
      // Leer filtros para que effect los rastree
      this.activeCategory();
      this.activeStatus();
      this.showOnlyMyClaims();
      // Resetear a página 1 cuando cambian los filtros
      this.currentPage.set(1);
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
    Bedding: "Blancos", // Or "Ropa de cama"
    Shoes: "Zapatos",
    Accessories: "Accesorios",
    Bathroom: "Baño",
    Office: "Oficina",
    Utilities: "Utilería", // Or "Servicios" depending on context
    Cleaning: "Limpieza",
    Sports: "Deportes",
    "Misc.": "Varios", // Handled as a string literal key due to the period
  } as const;

  // Pipeline combinado reactivo para calcular la rejilla en tiempo real
  readonly filteredItems = computed(() => {
    const categoryFilter = this.activeCategory();
    const statusFilter = this.activeStatus();
    const onlyMyClaims = this.showOnlyMyClaims();
    const myUsername = this.userService.currentUsername().toLowerCase();
    
    let list = this.inventoryService.items();

    // 1. Filtrado Prioritario: Mis elegidos
    if (onlyMyClaims && myUsername) {
      return list.filter(item => 
        item.queue.some(q => q.username.toLowerCase() === myUsername)
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
   */
  isUserInItemQueue(item: { queue: Array<{ username: string }> }): boolean {
    const username = this.userService.currentUsername();
    if (!username) return false;
    return item.queue.some(q => q.username.toLowerCase() === username.toLowerCase());
  }

  async onClaimItem(itemId: string): Promise<void> {
    const username = this.userService.currentUsername();
    const session = this.userService.session();
    if (!username) return;

    try {
      const response = await this.inventoryService.submitClaim(
        itemId,
        username,
        session?.email || null,
        session?.phone || null
      );
      alert(response.message || '¡Acción registrada con éxito!');
    } catch (err: any) {
      alert(`Error al reclamar: ${err.message}`);
    }
  }
}
