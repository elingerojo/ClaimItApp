import { Component, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms'; // 🧠 Requerido para enlazar [(ngModel)] con las señales de formulario
import { InventoryService } from '../../services/inventory';
import { ItemCategory } from '@claimitapp/shared';
import { upload } from '@vercel/blob/client'; // Helper oficial de Vercel para subir directo desde el navegador
import { railwayApiUrl } from '../../app.config';

@Component({
  selector: 'app-admin-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-panel.html'
})
export class AdminPanel {
  readonly inventoryService = inject(InventoryService);
  
  // Estados de control administrativo
  readonly adminToken = signal<string>('');
  readonly isAiProcessing = signal<boolean>(false);
  readonly previewUrl = signal<string>('');
  readonly uploadedBlobUrl = signal<string>('');

  // Señales de formulario para el autorelleno
  readonly formTitle = signal<string>('');
  readonly formDescription = signal<string>('');
  readonly formCategory = signal<ItemCategory>('Misc.');
  readonly formInfoUrl = signal<string>('');

  readonly categories: ItemCategory[] = [
    'Kitchen', 'Electronics', 'Decor', 'Books', 'Media', 
    'Clothing', 'Bedding', 'Shoes', 'Accessories', 'Bathroom', 
    'Office', 'Utilities', 'Cleaning', 'Sports', 'Misc.'
  ];

  private readonly apiUrl = railwayApiUrl;

  setToken(val: string): void {
    this.adminToken.set(val);
  }

  /**
   * Captura la foto directo de la cámara, la sube a Vercel Blobs y detona la IA
   */
  async onCameraCapture(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0]; // Capturamos el archivo binario individual
    
    // Generar preview visual local instantáneo en la pantalla del celular
    this.previewUrl.set(URL.createObjectURL(file));
    this.isAiProcessing.set(true);

    try {
      // 1. Subida directa a Vercel Blobs usando el canal de firmas seguro
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: `${this.apiUrl}/admin/blob-token`,
        // 🧠 CORRECCIÓN: Usamos clientPayload en lugar de headers para enviar metadatos al backend de forma segura
        clientPayload: JSON.stringify({ token: this.adminToken() })
      });

      this.uploadedBlobUrl.set(blob.url);

      // 2. Enviar la URL del asset a nuestro pipeline de análisis con Gemini Vision
      const aiRes = await fetch(`${this.apiUrl}/admin/analyze-item`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminToken()
        },
        body: JSON.stringify({ imageUrl: blob.url })
      });

      const aiResult = await aiRes.json();
      if (!aiRes.ok) throw new Error(aiResult.error || 'La IA falló al analizar el objeto.');

      // 3. ¡Magia! Autorellenar las señales reactivas del formulario
      const aiData = aiResult.data;
      this.formTitle.set(aiData.title || '');
      this.formDescription.set(aiData.description || '');
      this.formCategory.set(aiData.category || 'Misc.');
      this.formInfoUrl.set(aiData.infoUrl || '');

    } catch (err: any) {
      alert(`Error en el flujo de cámara/IA: ${err.message}`);
    } finally {
      this.isAiProcessing.set(false);
    }
  }

  /**
   * Guarda los datos aprobados definitivamente en la base de datos Neon
   */
  async onSaveItemToInventory(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/admin/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminToken()
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

      alert('¡Objeto publicado con éxito en el inventario!');
      
      // Limpiar formulario para el siguiente disparo de cámara
      this.previewUrl.set('');
      this.uploadedBlobUrl.set('');
      this.formTitle.set('');
      this.formDescription.set('');
      this.formCategory.set('Misc.');
      this.formInfoUrl.set('');

    } catch (err: any) {
      alert(`Error al guardar: ${err.message}`);
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
          'X-Admin-Token': this.adminToken()
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
