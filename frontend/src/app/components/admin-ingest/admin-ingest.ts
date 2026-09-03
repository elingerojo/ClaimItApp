import { Component, signal, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { ItemCategory } from '@claimitapp/shared';
import { upload } from '@vercel/blob/client';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { AdminAuth } from '../admin-auth/admin-auth';

/** Opción de evento para el selector de captura (GET /api/events). */
export interface EventOption {
  id: string;
  title: string;
}

@Component({
  selector: 'app-admin-ingest',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, StripAccentsPipe, AdminAuth],
  templateUrl: './admin-ingest.html'
})
export class AdminIngest implements OnInit {
  readonly inventoryService = inject(InventoryService);
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly isAiProcessing = signal<boolean>(false);
  readonly previewUrl = signal<string>('');
  readonly uploadedBlobUrl = signal<string>('');

  // Evento destino de la captura (persistente en localStorage hasta cambiarlo)
  readonly events = signal<EventOption[]>([]);
  readonly selectedEventId = signal<string>(''); // '' = Sin evento
  readonly loadingEvents = signal(false);
  private readonly INGEST_EVENT_STORAGE_KEY = 'claimit_ingest_event_id';

  // Form signals for AI auto-fill
  readonly formTitle = signal<string>('');
  readonly formDescription = signal<string>('');
  readonly formCategory = signal<ItemCategory>('Misc.');
  readonly formInfoUrl = signal<string>('');
  readonly formPrecioBase = signal<number | null>(null);

  // Vertical editor state for the last-added item
  readonly editingItem = signal<ItemWithQueue | null>(null);
  readonly editTitle = signal<string>('');
  readonly editDescription = signal<string>('');
  readonly editInfoUrl = signal<string>('');

  // Campos adicionales del editor vertical (todo lo que soporta el PATCH admin).
  readonly editEventId = signal<string>(''); // '' = Sin evento
  readonly editPriceBase = signal<number | null>(null);
  readonly editVisibilityLevel = signal<number>(4);
  readonly editAvailableFrom = signal<string>(''); // datetime-local
  readonly editVisibleAt = signal<string>(''); // datetime-local
  /** true si el editor se abrió desde Gestionar Inventario (?edit=ITEM_ID). */
  readonly isPreloadedEdit = signal(false);

  readonly categories: ItemCategory[] = [
    'Kitchen', 'Electronics', 'Decor', 'Books', 'Media',
    'Clothing', 'Bedding', 'Shoes', 'Accessories', 'Bathroom',
    'Office', 'Utilities', 'Cleaning', 'Sports', 'Misc.'
  ];

  /** Opciones de visibilidad: 0=admin only, 1=familiares, 2=amigos, 3=conocidos, 4=público. */
  readonly visibilityOptions = [
    { value: 0, label: '0 — Solo admin' },
    { value: 1, label: '1 — Familiares' },
    { value: 2, label: '2 — Amigos' },
    { value: 3, label: '3 — Conocidos' },
    { value: 4, label: '4 — Público' }
  ];

  private readonly apiUrl = railwayApiUrl;

  /**
   * Al iniciar la vista: carga los eventos disponibles y restaura el event_id
   * persistido. Si no hay evento guardado (o ya no existe) queda 'Sin evento'.
   */
  ngOnInit(): void {
    void this.init();
  }

  /**
   * Flujo inicial: carga los eventos/selección persistida y, si venimos con
   * ?edit=ITEM_ID (botón Editar de Gestionar Inventario), precarga el editor
   * vertical con ese objeto para reutilizar el mismo código de edición.
   */
  private async init(): Promise<void> {
    await this.loadEventsAndRestoreSelection();

    const editId = this.route.snapshot.queryParamMap.get('edit');
    if (editId) {
      await this.preloadItemForEdit(editId);
    }
  }

  /** Carga un objeto existente (GET admin) y abre el editor vertical precargado. */
  private async preloadItemForEdit(itemId: string): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/admin/items/${itemId}`, {
        headers: { 'X-Admin-Token': this.adminTokenService.token() }
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No autorizado');
      const item = await res.json();

      this.editingItem.set({
        id: item.id,
        title: item.title,
        description: item.description,
        category: item.category,
        infoUrl: item.infoUrl,
        imageUrl: item.imageUrl,
        status: item.status,
        createdAt: item.createdAt,
        queue: item.queue ?? []
      });
      this.editTitle.set(item.title ?? '');
      this.editDescription.set(item.description ?? '');
      this.editInfoUrl.set(item.infoUrl ?? '');
      this.editEventId.set(item.eventId ?? '');
      this.editPriceBase.set(item.precioBaseCosto != null ? Number(item.precioBaseCosto) : null);
      this.editVisibilityLevel.set(item.visibilityLevel ?? 4);
      this.editAvailableFrom.set(this.toLocalInputValue(item.availableFrom));
      this.editVisibleAt.set(this.toLocalInputValue(item.visibleAt));
      this.isPreloadedEdit.set(true);

      this.scrollToEditor();
    } catch (err: any) {
      this.toastService.error(`Error al cargar el objeto para editar: ${err.message}`);
    }
  }

  /** ISO (UTC) → valor local para un <input type="datetime-local">. */
  private toLocalInputValue(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Valor de datetime-local → ISO (UTC), o null si viene vacío. */
  private fromLocalInputValue(value: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** Lleva al editor a la vista una vez que se haya renderizado. */
  private scrollToEditor(): void {
    setTimeout(() => {
      document.getElementById('item-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  /** Carga los eventos desde GET /api/events y restaura el event_id persistido. */
  private async loadEventsAndRestoreSelection(): Promise<void> {
    this.loadingEvents.set(true);
    try {
      const res = await fetch(`${this.apiUrl}/events`);
      if (!res.ok) throw new Error('No se pudo obtener la lista de eventos');
      const data = await res.json();
      const events: EventOption[] = (data.events ?? []).map((ev: any) => ({
        id: ev.id,
        title: ev.title ?? 'Evento sin título'
      }));
      this.events.set(events);

      const storedId = this.readStoredEventId();
      if (storedId && events.some(ev => ev.id === storedId)) {
        this.selectedEventId.set(storedId);
      } else if (storedId) {
        // El evento guardado ya no existe (pudo ser eliminado): limpiar la clave
        this.clearStoredEventId();
      }
    } catch (err: any) {
      this.toastService.error(`No se pudieron cargar los eventos: ${err.message}`);
    } finally {
      this.loadingEvents.set(false);
    }
  }

  /**
   * Cambia el evento actual de la captura y lo persiste: de aquí en adelante
   * todas las capturas serán de este evento hasta que se cambie manualmente.
   */
  onEventChange(eventId: string): void {
    this.selectedEventId.set(eventId);
    this.writeStoredEventId(eventId);
  }

  /** Persiste el event_id elegido tras guardar una captura (cubre la primera vez). */
  private persistSelectedEvent(): void {
    this.writeStoredEventId(this.selectedEventId());
  }

  private readStoredEventId(): string {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(this.INGEST_EVENT_STORAGE_KEY) ?? '';
  }

  private writeStoredEventId(eventId: string): void {
    if (typeof localStorage === 'undefined') return;
    if (eventId) localStorage.setItem(this.INGEST_EVENT_STORAGE_KEY, eventId);
    else localStorage.removeItem(this.INGEST_EVENT_STORAGE_KEY);
  }

  private clearStoredEventId(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.INGEST_EVENT_STORAGE_KEY);
  }

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
          imageUrl: this.uploadedBlobUrl(),
          precio_base_costo: this.formPrecioBase(),
          event_id: this.selectedEventId() || null
        })
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al persistir el objeto.');

      this.toastService.success('¡Objeto publicado con éxito en el inventario!');
      this.persistSelectedEvent();

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
      this.editEventId.set(this.selectedEventId());
      this.editPriceBase.set(this.formPrecioBase());
      this.editVisibilityLevel.set(4);
      this.editAvailableFrom.set('');
      this.editVisibleAt.set('');
      this.isPreloadedEdit.set(false);

      // Clear the ingest form for the next item
      this.previewUrl.set('');
      this.uploadedBlobUrl.set('');
      this.formTitle.set('');
      this.formDescription.set('');
      this.formCategory.set('Misc.');
      this.formInfoUrl.set('');
      this.formPrecioBase.set(null);

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
    if (!this.editTitle().trim()) {
      this.toastService.error('El título es obligatorio.');
      return;
    }

    const body: Record<string, any> = {
      title: this.editTitle().trim(),
      description: this.editDescription() === '' ? null : this.editDescription(),
      infoUrl: this.editInfoUrl() === '' ? null : this.editInfoUrl(),
      event_id: this.editEventId() || null,
      precio_base_costo: this.editPriceBase(),
      visibility_level: this.editVisibilityLevel(),
      available_from: this.fromLocalInputValue(this.editAvailableFrom()),
      visible_at: this.fromLocalInputValue(this.editVisibleAt())
    };

    try {
      const res = await fetch(`${this.apiUrl}/admin/items/${item.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify(body)
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Error al actualizar el objeto.');

      this.toastService.success('✅ Objeto actualizado con éxito.');

      // Refrescar el catálogo para propagar eventSummary/estado/visibilidad.
      await this.inventoryService.refresh().catch(() => {});

      const returnToManage = this.isPreloadedEdit();
      this.cancelEdit();

      if (returnToManage) {
        // El editor se abrió desde Gestionar Inventario: regresar a esa vista.
        await this.router.navigate(['/admin/manage']);
      }
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
    this.editEventId.set('');
    this.editPriceBase.set(null);
    this.editVisibilityLevel.set(4);
    this.editAvailableFrom.set('');
    this.editVisibleAt.set('');
    this.isPreloadedEdit.set(false);
  }
}
