import { Component, input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';

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

  close(): void {
    this.onClose()();
  }

  isUserInItemQueue(): boolean {
    const username = this.userService.currentUsername();
    if (!username) return false;
    return this.item().queue.some(q => q.username.toLowerCase() === username.toLowerCase());
  }

  async onClaimItem(): Promise<void> {
    const item = this.item();
    const username = this.userService.currentUsername();
    const session = this.userService.session();
    if (!username) return;

    try {
      const response = await this.inventoryService.submitClaim(
        item.id,
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
