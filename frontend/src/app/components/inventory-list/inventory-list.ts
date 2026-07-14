import { Component, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InventoryService } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ItemCategory, ItemStatus } from '@claimitapp/shared';

@Component({
  selector: 'app-inventory-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './inventory-list.html'
})
export class InventoryList {
  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);

  // Señales reactivas para los nuevos estados de filtrado
  readonly activeCategory = signal<string>('All');
  readonly activeStatus = signal<string>('All');
  readonly showOnlyMyClaims = signal<boolean>(false);

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
