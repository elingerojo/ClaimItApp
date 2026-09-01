import { Component, input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ToastService } from '../../services/toast';

@Component({
  selector: 'app-item-detail',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe],
  templateUrl: './item-detail.html'
})
export class ItemDetail {
  readonly item = input.required<ItemWithQueue>();
  readonly onClose = input.required<() => void>();

  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);
  readonly toastService = inject(ToastService);

  close(): void {
    this.onClose()();
  }

  /**
   * Verifica si el usuario autenticado ya está en la cola de este objeto.
   * Compara por userUuid para precisión (el alias puede cambiar).
   */
  isUserInItemQueue(): boolean {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return false;
    return this.item().queue.some(q => q.userUuid === myUuid);
  }

  async onClaimItem(): Promise<void> {
    const item = this.item();
    const userUuid = this.userService.currentUuid();
    const session = this.userService.session();
    if (!userUuid) return;

    try {
      const response = await this.inventoryService.submitClaim(
        item.id,
        userUuid,
        session?.email || null,
        session?.phone || null
      );
      this.toastService.success(response.message || '¡Acción registrada con éxito!');
      this.close();
    } catch (err: any) {
      this.toastService.error(`Error al reclamar: ${err.message}`);
    }
  }
}
