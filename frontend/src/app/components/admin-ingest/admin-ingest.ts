import { Component, signal, computed, inject, OnInit } from '@angular/core';
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

/** Opción de evento para los selectores (GET /api/events). */
export interface EventOption {
  id: string;
  title: string;
  /** Estado del evento (draft|scheduled|active|closing|closed). */
  status?: string;
}

/** Máximo de fotos que se envían a Gemini en una sola llamada (índices 0..2). */
const MAX_IMAGES_TO_ANALYZE = 3;

/**
 * Mueve un elemento de un arreglo una posición (dir = -1 izquierda | +1 derecha).
 * Devuelve un arreglo nuevo (inmutable); no muta el original.
 */
function moveInArray<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
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

  // ---- Estado de subida / análisis IA ----
  /** Subiendo una o más fotos a Vercel Blob. */
  readonly isUploading = signal<boolean>(false);
  /** Análisis IA en curso para la captura (nuevo Item). */
  readonly isAiProcessing = signal<boolean>(false);
  /** Análisis IA en curso para el editor (Item existente). */
  readonly isEditAiProcessing = signal<boolean>(false);

  // ---- Fotos de la CAPTURA (nuevo Item): lista ordenada local hasta guardar ----
  readonly captureImages = signal<string[]>([]);
  // ---- Fotos del EDITOR (Item existente): lista ordenada local hasta PATCH ----
  readonly editImages = signal<string[]>([]);

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
  /** true si el editor se abrió desde Gestionar Inventario (?edit=ITEM_ID). */
  readonly isPreloadedEdit = signal(false);

  /** Eventos no cerrados: candidatos para asignar un item (captura y edición). */
  readonly availableEvents = computed<EventOption[]>(() =>
    this.events().filter(ev => ev.status !== 'closed')
  );

  /**
   * Opciones del select del editor: los eventos disponibles + el evento actual
   * del item aunque esté 'closed' (Cerrado), para que se vea pre-seleccionado
   * y no se pierda la asignación al guardar sin cambiarlo.
   */
  readonly editorEventOptions = computed<EventOption[]>(() => {
    const options = this.availableEvents();
    const currentId = this.editEventId();
    if (!currentId) return options;
    if (options.some(ev => ev.id === currentId)) return options;
    const current = this.events().find(ev => ev.id === currentId);
    return current ? [...options, current] : options;
  });

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

      const imageUrls: string[] = Array.isArray(item.imageUrls) ? item.imageUrls : [];
      this.editingItem.set({
        id: item.id,
        title: item.title,
        description: item.description,
        category: item.category,
        infoUrl: item.infoUrl,
        imageUrls,
        status: item.status,
        createdAt: item.createdAt,
        queue: item.queue ?? []
      });
      this.editImages.set(imageUrls);
      this.editTitle.set(item.title ?? '');
      this.editDescription.set(item.description ?? '');
      this.editInfoUrl.set(item.infoUrl ?? '');
      this.editEventId.set(item.eventId ?? '');
      this.editPriceBase.set(item.precioBaseCosto != null ? Number(item.precioBaseCosto) : null);
      this.editVisibilityLevel.set(item.visibilityLevel ?? 4);
      this.isPreloadedEdit.set(true);

      this.scrollToEditor();
    } catch (err: any) {
      this.toastService.error(`Error al cargar el objeto para editar: ${err.message}`);
    }
  }

  /** Lleva al editor a la vista una vez que se haya renderizado. */
  private scrollToEditor(): void {
    setTimeout(() => {
      document.getElementById('item-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  /** Carga los eventos (con status) desde GET /api/events y restaura el event_id persistido. */
  private async loadEventsAndRestoreSelection(): Promise<void> {
    this.loadingEvents.set(true);
    try {
      const res = await fetch(`${this.apiUrl}/events?limit=100`);
      if (!res.ok) throw new Error('No se pudo obtener la lista de eventos');
      const data = await res.json();
      const events: EventOption[] = (data.events ?? []).map((ev: any) => ({
        id: ev.id,
        title: ev.title ?? 'Evento sin título',
        status: ev.status ?? ''
      }));
      this.events.set(events);

      // Solo se restaura como destino de captura un evento que no esté cerrado.
      const storedId = this.readStoredEventId();
      if (storedId && events.some(ev => ev.id === storedId && ev.status !== 'closed')) {
        this.selectedEventId.set(storedId);
      } else if (storedId) {
        // El evento guardado ya no existe o quedó 'closed' (Cerrado): limpiar la clave
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

  // ==========================================================================
  //  SUBIDA MÚLTIPLE A VERCEL BLOB (compartida por captura y editor)
  // ==========================================================================

  /**
   * Sube cada archivo a Vercel Blob y devuelve sus URLs públicas. Cada foto se
   * sube de inmediato (el editor acumula las URLs en memoria hasta guardar).
   */
  private async uploadFiles(files: File[]): Promise<string[]> {
    const urls: string[] = [];
    for (const file of files) {
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: `${this.apiUrl}/admin/blob-token`,
        clientPayload: JSON.stringify({ token: this.adminTokenService.token() })
      });
      urls.push(blob.url);
    }
    return urls;
  }

  /** Agrega las fotos elegidas (cámara/galería) a la lista de la CAPTURA. */
  async onCapturePhotos(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const files = Array.from(input.files);
    input.value = ''; // permite volver a elegir el mismo archivo
    if (files.length === 0) return;

    this.isUploading.set(true);
    try {
      const urls = await this.uploadFiles(files);
      this.captureImages.update(list => [...list, ...urls]);
    } catch (err: any) {
      this.toastService.error(`Error al subir la(s) foto(s): ${err.message}`);
    } finally {
      this.isUploading.set(false);
    }
  }

  /** Agrega las fotos elegidas a la lista del EDITOR (Item existente). */
  async onEditPhotos(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const files = Array.from(input.files);
    input.value = '';
    if (files.length === 0) return;

    this.isUploading.set(true);
    try {
      const urls = await this.uploadFiles(files);
      this.editImages.update(list => [...list, ...urls]);
    } catch (err: any) {
      this.toastService.error(`Error al subir la(s) foto(s): ${err.message}`);
    } finally {
      this.isUploading.set(false);
    }
  }

  // ---- Gestión local (captura): reordenar / quitar ----

  /** Mueve una foto de la captura una posición (dir -1 ◀ | +1 ▶). */
  moveCapturePhoto(index: number, dir: -1 | 1): void {
    this.captureImages.update(list => moveInArray(list, index, dir));
  }

  /** Quita una foto de la captura (puede quedar en 0; guardar queda bloqueado). */
  removeCapturePhoto(index: number): void {
    this.captureImages.update(list => list.filter((_, i) => i !== index));
  }

  // ---- Gestión local (editor): reordenar / quitar ----

  /** Mueve una foto del editor una posición (dir -1 ◀ | +1 ▶). */
  moveEditPhoto(index: number, dir: -1 | 1): void {
    this.editImages.update(list => moveInArray(list, index, dir));
  }

  /** Quita una foto del editor; bloqueado si quedaría 0 (mínimo 1 foto por Item). */
  removeEditPhoto(index: number): void {
    if (this.editImages().length <= 1) return;
    this.editImages.update(list => list.filter((_, i) => i !== index));
  }

  // ==========================================================================
  //  ANÁLISIS GEMINI MANUAL (hasta las primeras 3 fotos de la lista ordenada)
  // ==========================================================================

  /** Llama al backend que envía hasta las primeras 3 fotos a Gemini en un solo request. */
  private async analyzeUrls(urls: string[]): Promise<any> {
    if (urls.length === 0) throw new Error('Agrega al menos una foto antes de analizar.');
    const aiRes = await fetch(`${this.apiUrl}/admin/analyze-item`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': this.adminTokenService.token()
      },
      body: JSON.stringify({ imageUrls: urls.slice(0, MAX_IMAGES_TO_ANALYZE) })
    });

    const aiResult = await aiRes.json();
    if (!aiRes.ok) throw new Error(aiResult.error || 'La IA falló al analizar el objeto.');
    return aiResult.data;
  }

  /** Botón "Analizar con IA" de la CAPTURA: rellena el formulario de creación. */
  async analyzeCapture(): Promise<void> {
    const urls = this.captureImages();
    if (urls.length === 0) {
      this.toastService.error('Agrega al menos una foto para analizar.');
      return;
    }
    this.isAiProcessing.set(true);
    try {
      const aiData = await this.analyzeUrls(urls);
      this.formTitle.set(aiData.title || '');
      this.formDescription.set(aiData.description || '');
      this.formCategory.set(aiData.category || 'Misc.');
      this.formInfoUrl.set(aiData.infoUrl || '');
    } catch (err: any) {
      this.toastService.error(`Error en el análisis IA: ${err.message}`);
    } finally {
      this.isAiProcessing.set(false);
    }
  }

  /** Botón "Analizar con IA" del EDITOR: rellena los campos de edición. */
  async analyzeEdit(): Promise<void> {
    const urls = this.editImages();
    if (urls.length === 0) {
      this.toastService.error('Agrega al menos una foto para analizar.');
      return;
    }
    this.isEditAiProcessing.set(true);
    try {
      const aiData = await this.analyzeUrls(urls);
      if (aiData.title) this.editTitle.set(aiData.title);
      if (aiData.description) this.editDescription.set(aiData.description);
      if (aiData.infoUrl) this.editInfoUrl.set(aiData.infoUrl);
    } catch (err: any) {
      this.toastService.error(`Error en el análisis IA: ${err.message}`);
    } finally {
      this.isEditAiProcessing.set(false);
    }
  }

  // ==========================================================================
  //  GUARDADO
  // ==========================================================================

  /**
   * Saves the item (with its full ordered photo array) to the database, then
   * auto-opens the vertical editor for the last-added item.
   */
  async onSaveItemToInventory(): Promise<void> {
    const images = this.captureImages();
    if (images.length === 0) {
      this.toastService.error('Agrega al menos una foto antes de guardar.');
      return;
    }
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
          imageUrls: images,
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
      const newImages: string[] = Array.isArray(newItem.imageUrls) ? newItem.imageUrls : images;
      this.editingItem.set({
        id: newItem.id,
        title: newItem.title,
        description: newItem.description,
        category: newItem.category,
        infoUrl: newItem.infoUrl,
        imageUrls: newImages,
        status: newItem.status,
        createdAt: newItem.createdAt,
        queue: []
      });
      this.editImages.set(newImages);
      this.editTitle.set(newItem.title);
      this.editDescription.set(newItem.description || '');
      this.editInfoUrl.set(newItem.infoUrl || '');
      this.editEventId.set(this.selectedEventId());
      this.editPriceBase.set(this.formPrecioBase());
      this.editVisibilityLevel.set(4);
      this.isPreloadedEdit.set(false);

      // Clear the ingest form for the next item
      this.captureImages.set([]);
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
   * Persists edits made in the vertical editor (including the ordered photo array).
   */
  async onSaveEdit(): Promise<void> {
    const item = this.editingItem();
    if (!item) return;
    if (!this.editTitle().trim()) {
      this.toastService.error('El título es obligatorio.');
      return;
    }
    if (this.editImages().length === 0) {
      this.toastService.error('El objeto debe conservar al menos una foto.');
      return;
    }

    const body: Record<string, any> = {
      title: this.editTitle().trim(),
      description: this.editDescription() === '' ? null : this.editDescription(),
      infoUrl: this.editInfoUrl() === '' ? null : this.editInfoUrl(),
      imageUrls: this.editImages(),
      event_id: this.editEventId() || null,
      precio_base_costo: this.editPriceBase(),
      visibility_level: this.editVisibilityLevel()
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
    this.editImages.set([]);
    this.editTitle.set('');
    this.editDescription.set('');
    this.editInfoUrl.set('');
    this.editEventId.set('');
    this.editPriceBase.set(null);
    this.editVisibilityLevel.set(4);
    this.isPreloadedEdit.set(false);
  }
}
