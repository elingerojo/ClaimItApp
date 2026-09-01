import { Component, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { ItemCategory } from '@claimitapp/shared';
import { upload } from '@vercel/blob/client';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { AdminAuth } from '../admin-auth/admin-auth';

@Component({
  selector: 'app-admin-ingest',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, StripAccentsPipe, AdminAuth],
  templateUrl: './admin-ingest.html'
})
export class AdminIngest {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);

  readonly isAiProcessing = signal<boolean>(false);
  readonly previewUrl = signal<string>('');
  readonly uploadedBlobUrl = signal<string>('');

  // Form signals for AI auto-fill
  readonly formTitle = signal<string>('');
  readonly formDescription = signal<string>('');
  readonly formCategory = signal<ItemCategory>('Misc.');
  readonly formInfoUrl = signal<string>('');

  // Vertical editor state for the last-added item
  readonly editingItem = signal<ItemWithQueue | null>(null);
  readonly editTitle = signal<string>('');
  readonly editDescription = signal<string>('');
  readonly editInfoUrl = signal<string>('');

  readonly categories: ItemCategory[] = [
    'Kitchen', 'Electronics', 'Decor', 'Books', 'Media',
    'Clothing', 'Bedding', 'Shoes', 'Accessories', 'Bathroom',
    'Office', 'Utilities', 'Cleaning', 'Sports', 'Misc.'
  ];

  private readonly apiUrl = railwayApiUrl;

  /**
   * Captures photo from camera, uploads to Vercel Blobs, triggers AI analysis
   */
  async onCameraCapture(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    this.previewUrl.set(URL.createObjectURL(file));
    this.isAiProcessing.set(true);

    try {
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: `${this.apiUrl}/admin/blob-token`,
        clientPayload: JSON.stringify({ token: this.adminTokenService.token() })
      });

      this.uploadedBlobUrl.set(blob.url);

      const aiRes = await fetch(`${this.apiUrl}/admin/analyze-item`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({ imageUrl: blob.url })
      });

      const aiResult = await aiRes.json();
      if (!aiRes.ok) throw new Error(aiResult.error || 'La IA falló al analizar el objeto.');

      const aiData = aiResult.data;
      this.formTitle.set(aiData.title || '');
      this.formDescription.set(aiData.description || '');
      this.formCategory.set(aiData.category || 'Misc.');
      this.formInfoUrl.set(aiData.infoUrl || '');

    } catch (err: any) {
      this.toastService.error(`Error en el flujo de cámara/IA: ${err.message}`);
    } finally {
      this.isAiProcessing.set(false);
    }
  }

  /**
   * Saves the item to the database, then auto-opens the vertical editor
   * for the last-added item
   */
  async onSaveItemToInventory(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/admin/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({
          title: this.formTitle(),
          description: this.formDescription(),
          category: this.formCategory(),
          infoUrl: this.formInfoUrl(),
          imageUrl: this.uploadedBlobUrl()
        })
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al persistir el objeto.');

      this.toastService.success('¡Objeto publicado con éxito en el inventario!');

      // Auto-open vertical editor for the newly created item
      const newItem = result.item;
      this.editingItem.set({
        id: newItem.id,
        title: newItem.title,
        description: newItem.description,
        category: newItem.category,
        infoUrl: newItem.infoUrl,
        imageUrl: newItem.imageUrl,
        status: newItem.status,
        createdAt: newItem.createdAt,
        queue: []
      });
      this.editTitle.set(newItem.title);
      this.editDescription.set(newItem.description || '');
      this.editInfoUrl.set(newItem.infoUrl || '');

      // Clear the ingest form for the next item
      this.previewUrl.set('');
      this.uploadedBlobUrl.set('');
      this.formTitle.set('');
      this.formDescription.set('');
      this.formCategory.set('Misc.');
      this.formInfoUrl.set('');

    } catch (err: any) {
      this.toastService.error(`Error al guardar: ${err.message}`);
    }
  }

  /**
   * Persists edits made in the vertical editor
   */
  async onSaveEdit(): Promise<void> {
    const item = this.editingItem();
    if (!item) return;

    try {
      const res = await fetch(`${this.apiUrl}/admin/items/${item.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({
          title: this.editTitle(),
          description: this.editDescription(),
          infoUrl: this.editInfoUrl()
        })
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al actualizar el objeto.');

      this.toastService.success('✅ Objeto actualizado con éxito.');
      this.cancelEdit();
    } catch (err: any) {
      this.toastService.error(`Error al guardar: ${err.message}`);
    }
  }

  /**
   * Closes the vertical editor
   */
  cancelEdit(): void {
    this.editingItem.set(null);
    this.editTitle.set('');
    this.editDescription.set('');
    this.editInfoUrl.set('');
  }
}
