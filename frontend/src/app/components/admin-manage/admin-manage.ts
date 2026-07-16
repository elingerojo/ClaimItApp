import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { InventoryService } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';

@Component({
  selector: 'app-admin-manage',
  standalone: true,
  imports: [CommonModule, RouterModule, StripAccentsPipe],
  templateUrl: './admin-manage.html'
})
export class AdminManage {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);

  private readonly apiUrl = railwayApiUrl;

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
      alert('¡Línea actualizada con éxito!');
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }
}
