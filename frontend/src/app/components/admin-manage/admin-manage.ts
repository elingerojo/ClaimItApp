import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { InventoryService } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { AdminAuth } from '../admin-auth/admin-auth';

@Component({
  selector: 'app-admin-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, StripAccentsPipe, AdminAuth],
  templateUrl: './admin-manage.html'
})
export class AdminManage {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);

  private readonly apiUrl = railwayApiUrl;

  async handleDeleteItem(itemId: string, title: string): Promise<void> {
    const confirmation = confirm(`¿Estás seguro de que deseas eliminar "${title}"? Esta acción no se puede deshacer.`);
    if (!confirmation) return;

    try {
      await this.inventoryService.deleteItem(itemId, this.adminTokenService.token());
      this.toastService.success('¡Objeto eliminado con éxito!');
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
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }
}
