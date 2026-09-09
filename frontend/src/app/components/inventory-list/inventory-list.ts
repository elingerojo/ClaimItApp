import { Component, signal, computed, inject, effect, OnInit } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { InventoryService, ItemWithQueue, EventSummary, QueueEntry } from '../../services/inventory';
import { UserService, StoredUserProfile } from '../../services/user';
import { ToastService } from '../../services/toast';
import { InvitationService } from '../../services/invitations';
import { ItemCategory } from '@claimitapp/shared';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { CategoryEsPipe } from '../../pipes/category-es.pipe';
import { CATEGORY_LABELS, categoryLabel } from '../../utils/category-label';
import { ItemDetail } from '../item-detail/item-detail';
import {
  eventStatusBadge,
  eventStatusLabel,
  phaseBadge,
  phaseEmoji,
  phaseChipText,
  claimStateEmoji
} from '../../utils/event-status';

@Component({
  selector: 'app-inventory-list',
  standalone: true,
  imports: [CommonModule, NgOptimizedImage, StripAccentsPipe, DateEsPipe, CategoryEsPipe, ItemDetail],
  templateUrl: './inventory-list.html'
})
export class InventoryList implements OnInit {
  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);
  readonly toastService = inject(ToastService);
  private readonly invitationService = inject(InvitationService);

  // Señal para el item seleccionado en el modal de detalle
  readonly selectedItem = signal<ItemWithQueue | null>(null);

  // Señal para detectar pantalla grande (≥ 1024px)
  readonly isLargeScreen = signal(
    typeof window !== 'undefined' ? window.innerWidth >= 1024 : false
  );

  // Paginación
  readonly currentPage = signal(1);

  // Opciones de pageSize según tamaño de pantalla (isLargeScreen = ≥1024px).
  // Chica (<1024px): 12/25/50 · Grande (≥1024px): 25/50/100
  readonly pageSizeOptions = computed(() =>
    this.isLargeScreen() ? [25, 50, 100] : [12, 25, 50]
  );

  // Tamaño de página elegido por el usuario (default: el menor de la pantalla actual)
  readonly pageSize = signal<number>(this.pageSizeOptions()[0]);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredItems().length / this.pageSize()))
  );
  readonly paginatedItems = computed(() => {
    const allItems = this.filteredItems();
    const start = (this.currentPage() - 1) * this.pageSize();
    return allItems.slice(start, start + this.pageSize());
  });

  // Señales reactivas para los nuevos estados de filtrado
  readonly activeCategory = signal<string>('All');
  readonly activeStatus = signal<string>('All');
  readonly showOnlyMyClaims = signal<boolean>(false);

  // ---- Contexto de evento (Fase 1): derivado del feed (eventSummary por item) ----
  /** Eventos presentes en el catálogo con su resumen y nº de objetos. */
  readonly eventContexts = computed(() => {
    const byId = new Map<string, EventSummary & { count: number }>();
    for (const item of this.inventoryService.items()) {
      const ev = item.eventSummary;
      if (!ev) continue;
      const prev = byId.get(ev.id);
      if (prev) prev.count += 1;
      else byId.set(ev.id, { ...ev, count: 1 });
    }
    return [...byId.values()];
  });
  /** Evento seleccionado como filtro (null = todos). */
  readonly selectedEventId = signal<string | null>(null);
  /** Bindings de utilidades de estado de evento y fase v2 para la plantilla. */
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;
  readonly phaseBadge = phaseBadge;
  readonly phaseEmoji = phaseEmoji;
  readonly phaseChipText = phaseChipText;
  readonly claimStateEmoji = claimStateEmoji;

  selectEvent(id: string | null): void {
    this.selectedEventId.set(id);
    this.currentPage.set(1);
  }

  // Clases Tailwind para el badge de rol del usuario
  readonly roleBadgeClass = computed(() => {
    const role = this.userService.currentRole();
    return {
      familiares: 'bg-purple-100 text-purple-700',
      amigos: 'bg-blue-100 text-blue-700',
      conocidos: 'bg-gray-100 text-gray-600',
      publico: 'bg-gray-200 text-gray-500'
    }[role] ?? 'bg-gray-100 text-gray-500';
  });

  // Estado del diálogo de conflicto de alias
  readonly conflictDialogVisible = signal(false);
  readonly conflictData = signal<{
    alias: string;
    storedUuid: string;
    storedAlias: string;
    email: string | null;
    phone: string | null;
    storedUser?: StoredUserProfile;
  } | null>(null);

  // Estado de carga para el botón Guardar
  readonly isSaving = signal(false);

  /**
   * Modo edición de identidad ("Cambiar Alias").
   * Al activarlo NO se borra claimit_uuid del localStorage: conservar el UUID
   * mantiene la identidad y por tanto los apartados previos (comparados por
   * userUuid) siguen visibles, y el servidor toma la ruta de UPDATE (no crea
   * un usuario nuevo ni devuelve databaseReset).
   */
  readonly isEditingIdentity = signal(false);

  ngOnInit(): void {
    // Visitante que YA tiene sesión guardada y llega con ?invite=TOKEN:
    // la invitación se acepta automáticamente (el home no cambia su aspecto).
    if (this.userService.isAuthenticated()) {
      void this.acceptPendingInvite();
    }
  }

  /**
   * "Magia" al resolver la identidad: si hay una invitación pendiente
   * (detectada en la URL del home), se acepta contra el backend. En éxito se
   * aplica el rol otorgado y se refresca el catálogo; si el enlace ya no es
   * válido, se avisa sin bloquear (el usuario sigue como público).
   */
  private async acceptPendingInvite(): Promise<void> {
    if (!this.invitationService.hasPending()) return;
    const uuid = this.userService.currentUuid();
    if (!uuid) return;

    const result = await this.invitationService.acceptPending(uuid);
    if (result.accepted) {
      if (result.role) this.userService.setRole(result.role);
      this.inventoryService.refresh().catch(() => {});
      this.toastService.success(result.message || '🎉 ¡Ya formas parte del evento!');
    } else if (result.invalid) {
      this.toastService.info(
        'El enlace de invitación ya no es válido. Pídele un enlace nuevo a quien te invitó; mientras tanto puedes navegar el catálogo.'
      );
    }
    // Error de red: se conserva el pendiente para reintentar en la siguiente acción.
  }

  constructor() {
    // Detectar cambios de tamaño de ventana en tiempo real
    if (typeof window !== 'undefined') {
      const mql = window.matchMedia('(min-width: 1024px)');
      this.isLargeScreen.set(mql.matches);
      mql.addEventListener('change', (e) => {
        this.isLargeScreen.set(e.matches);
      });
    }

    // Resetear a página 1 cuando cambian los filtros
    effect(() => {
      this.activeCategory();
      this.activeStatus();
      this.showOnlyMyClaims();
      this.selectedEventId();
      this.currentPage.set(1);
    });

    // Protección: corregir página si excede el total (ocurre al redimensionar)
    effect(() => {
      const max = this.totalPages();
      if (this.currentPage() > max) {
        this.currentPage.set(max);
      }
    });

    // Mantener el modal de detalle "en vivo": re-apuntar selectedItem al objeto
    // fresco del feed (tras SSE/refresh) conservando el mismo id.
    effect(() => {
      const current = this.selectedItem();
      if (!current) return;
      const fresh = this.inventoryService.items().find((it) => it.id === current.id);
      if (fresh && fresh !== current) this.selectedItem.set(fresh);
    });
  }

  readonly categories: ItemCategory[] = Object.keys(CATEGORY_LABELS) as ItemCategory[];
  /** Traducción centralizada de categoría a español (para atributos/title). */
  readonly categoryLabel = categoryLabel;

  // Pipeline combinado reactivo para calcular la rejilla en tiempo real
  readonly filteredItems = computed(() => {
    const categoryFilter = this.activeCategory();
    const statusFilter = this.activeStatus();
    const onlyMyClaims = this.showOnlyMyClaims();
    const myUuid = this.userService.currentUuid();
    
    let list = this.inventoryService.items();

    // 0. Filtro por evento (Fase 1): si hay un evento seleccionado, solo sus objetos.
    const eventFilter = this.selectedEventId();
    if (eventFilter) {
      list = list.filter(item => item.eventSummary?.id === eventFilter);
    }

    // 1. Filtrado Prioritario: Mis elegidos (solo claims ACTIVOS v2 — myClaim)
    if (onlyMyClaims && myUuid) {
      return list.filter(item => this.myActiveClaimOf(item) != null);
    }

    // 2. Filtrado por Categorías
    if (categoryFilter !== 'All') {
      list = list.filter(item => item.category === categoryFilter);
    }

    // 3. Filtrado por Fase v2 (ItemPhase: claim_open/pickup_turns/ventana_libre/...)
    if (statusFilter !== 'All') {
      list = list.filter(item => item.phase === statusFilter);
    }

    return list;
  });

  goToPage(page: number): void {
    const clamped = Math.max(1, Math.min(page, this.totalPages()));
    this.currentPage.set(clamped);
  }

  /** Cambia cuántos objetos se muestran por página y regresa a la página 1. */
  setPageSize(size: number): void {
    this.pageSize.set(size);
    this.currentPage.set(1);
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
   * Verifica si el usuario autenticado tiene un claim ACTIVO en la cola de un
   * objeto (v2: los claims cancelados/expirados/void ya no cuentan).
   * Compara por userUuid para precisión (el alias puede cambiar).
   */
  isUserInItemQueue(item: { queue: Array<QueueEntry> }): boolean {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return false;
    return (item.queue ?? []).some(q => q.userUuid === myUuid && q.claimState === 'active');
  }

  /** Mi claim activo en el item (o null). */
  myActiveClaimOf(item: { queue: Array<QueueEntry> }): QueueEntry | null {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return null;
    return (item.queue ?? []).find(q => q.userUuid === myUuid && q.claimState === 'active') ?? null;
  }

  /** Claims ACTIVOS de la cola, ordenados por posición FIFO (nulls last) y luego claimed_at. */
  activeQueueOf(item: { queue: Array<QueueEntry> }): QueueEntry[] {
    const queue = item.queue ?? [];
    return queue
      .filter((c) => c.claimState === 'active')
      .sort((a, b) => {
        const ap = a.fifoPosition ?? Number.MAX_SAFE_INTEGER;
        const bp = b.fifoPosition ?? Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime();
      });
  }

  /** Titular del turno activo (posición activa de menor rango). */
  activeHolderOf(item: { queue: Array<QueueEntry> }): QueueEntry | null {
    return this.activeQueueOf(item)[0] ?? null;
  }

  /** ¿El usuario autenticado es el titular activo (turno en curso)? */
  isFirstInLine(item: { queue: Array<QueueEntry> }): boolean {
    const holder = this.activeHolderOf(item);
    const myUuid = this.userService.currentUuid();
    return !!holder && !!myUuid && holder.userUuid === myUuid;
  }

  /** Posición FIFO (1-based) del usuario en la cola activa, o null si no está. */
  myQueuePosition(item: { queue: Array<QueueEntry> }): number | null {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return null;
    const myClaim = (item.queue ?? []).find(q => q.userUuid === myUuid && q.claimState === 'active');
    if (!myClaim) return null;
    if (myClaim.fifoPosition != null) return myClaim.fifoPosition;
    const idx = this.activeQueueOf(item).findIndex(q => q.id === myClaim.id || q.userUuid === myUuid);
    return idx >= 0 ? idx + 1 : null;
  }

  /** Vencimiento del turno activo (V del titular) o null. */
  activeTurnVOf(item: { queue: Array<QueueEntry> }): string | null {
    return this.activeHolderOf(item)?.turnVExpiresAt ?? null;
  }

  /** ¿La cola activa está llena (3)? */
  isQueueFull(item: { queue: Array<QueueEntry> }): boolean {
    return this.activeQueueOf(item).length >= 3;
  }

  /** Mi ventana por rol aún no abrió (claim_open, antes de claimFromForRole). */
  notYetOpenForMe(item: ItemWithQueue): boolean {
    const from = item.claimFromForRole ?? null;
    if (item.phase !== 'claim_open' || !this.userService.isAuthenticated()) return false;
    if (this.myActiveClaimOf(item)) return false;
    return !!from && new Date(from).getTime() > Date.now();
  }

  /** Cuenta regresiva estática (render-time) hacia `target`, o '' si no aplica. */
  countdownTo(target: string | null | undefined): string {
    if (!target) return '';
    const diff = new Date(target).getTime() - Date.now();
    if (diff <= 0) return '';
    const totalMin = Math.floor(diff / 60000);
    const hours = Math.floor((totalMin % 1440) / 60);
    const minutes = totalMin % 60;
    const seconds = Math.floor((diff % 60000) / 1000);
    if (totalMin >= 1440) return `${Math.floor(totalMin / 1440)}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  /** Tooltip de un chip de la cola activa en la tarjeta (v2). */
  queueTooltip(claimer: QueueEntry, idx: number): string {
    const isMe = claimer.userUuid === this.userService.currentUuid();
    const pos = claimer.fifoPosition != null ? ` (turno #${claimer.fifoPosition})` : '';
    if (idx === 0) return `👑 Primero en la lista${pos} — prioridad para recoger.`;
    if (isMe) return `✅ ¡Eres tú! Estás en la lista${pos}.`;
    return `En la lista${pos}`;
  }

  async onClaimItem(itemId: string): Promise<void> {
    const userUuid = this.userService.currentUuid();
    const session = this.userService.session();
    if (!userUuid) return;

    try {
      const response = await this.inventoryService.submitClaim(
        itemId,
        userUuid,
        session?.email || null,
        session?.phone || null
      );
      this.toastService.success(response.message || '¡Acción registrada con éxito!');
    } catch (err: any) {
      this.toastService.error(`Error al reclamar: ${err.message}`);
    }
  }

  /**
   * Abre el modo edición de identidad ("Cambiar Alias").
   * NO borra claimit_uuid del localStorage: conserva el UUID (identidad) y por
   * tanto los apartados previos; el guardado posterior toma la ruta UPDATE en
   * el servidor (sin databaseReset ni alta de usuario nuevo).
   */
  beginAliasEdit(): void {
    this.isEditingIdentity.set(true);
  }

  /**
   * Cancela el modo edición de identidad y regresa al badge de sesión.
   */
  cancelAliasEdit(): void {
    this.isEditingIdentity.set(false);
  }

  /**
   * Guarda los datos del usuario resolviendo la sesión contra el servidor.
   * Si hay conflicto de alias, muestra el diálogo correspondiente.
   * Con la identidad conservada (mismo UUID) el servidor actualiza el alias en
   * lugar de crear un usuario nuevo, así que no se emite databaseReset.
   */
  async onSaveSession(aliasInput: HTMLInputElement, emailInput: HTMLInputElement, phoneInput: HTMLInputElement): Promise<void> {
    const alias = aliasInput.value.trim();
    const email = emailInput.value.trim() || null;
    const phone = phoneInput.value.trim() || null;

    if (!alias) {
      this.toastService.error('Por favor ingresa un apodo o alias.');
      aliasInput.focus();
      return;
    }

    this.isSaving.set(true);

    try {
      const result = await this.userService.resolveSession(alias, email, phone);

      if (result.conflict && result.storedUuid && result.storedAlias) {
        // Mostrar diálogo de conflicto; se mantiene el modo edición abierto
        this.conflictData.set({
          alias: result.storedAlias,
          storedUuid: result.storedUuid,
          storedAlias: result.storedAlias,
          email,
          phone,
          storedUser: result.storedUser
        });
        this.conflictDialogVisible.set(true);
        return;
      }

      // Éxito: sesión resuelta (con el mismo UUID si el usuario ya existía).
      // Cerrar el modo edición y refrescar para reflejar el alias en las colas.
      this.isEditingIdentity.set(false);

      if (result.databaseReset) {
        // BD fue reiniciada desde la última visita del usuario (caso real de migración)
        this.toastService.info('La base de datos ha sido reiniciada desde tu última visita. Tus apartados anteriores ya no existen, pero tu identidad se ha conservado. ¡Bienvenido de nuevo!');
      }

      this.inventoryService.refresh().catch(() => {});
      await this.acceptPendingInvite();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * El usuario elige continuar con el alias existente (nuevo dispositivo)
   */
  onAcceptConflictAlias(): void {
    const data = this.conflictData();
    if (!data) return;

    if (data.storedUser) {
      // 'soy la misma persona': adoptar el perfil completo del alias ocupado
      // (contacto, rol global 'amigos', etc.) para que el 'pill' sea correcto.
      this.userService.adoptStoredUser(data.storedUser);
    } else {
      // Fallback: solo reutilizar el UUID/alias almacenado (compatibilidad).
      this.userService.acceptServerUuid(data.storedUuid, data.storedAlias, data.email, data.phone);
    }
    this.confirmDialogHidden();
    this.isEditingIdentity.set(false);
    this.inventoryService.refresh().catch(() => {});
    void this.acceptPendingInvite();
  }

  /**
   * El usuario elige elegir otro alias
   */
  onRejectConflictAlias(): void {
    this.confirmDialogHidden();
    // Focus en el input de alias después de cerrar el diálogo
    setTimeout(() => {
      const aliasInput = document.querySelector<HTMLInputElement>('input[placeholder="Apodo o alias"]');
      aliasInput?.focus();
      aliasInput?.select();
    }, 100);
  }

  private confirmDialogHidden(): void {
    this.conflictDialogVisible.set(false);
    this.conflictData.set(null);
  }

  /**
   * Intenta variantes tocoyo-N cuando hay conflicto de alias.
   * Usa los datos almacenados en conflictData().
   * Empieza en 2 (el 1 es el alias original).
   */
  async onTryTocayoFromDialog(): Promise<void> {
    const data = this.conflictData();
    if (!data) return;

    const baseAlias = data.storedAlias;
    const email = data.email;
    const phone = data.phone;

    this.isSaving.set(true);
    this.confirmDialogHidden();

    try {
      for (let n = 2; n <= 9; n++) {
        const tocayoAlias = `${baseAlias}-tocayo-${n}`;
        const result = await this.userService.resolveSession(tocayoAlias, email, phone);
        if (result.success) {
          // Alias tocayo aceptado
          this.isEditingIdentity.set(false);
          this.inventoryService.refresh().catch(() => {});
          await this.acceptPendingInvite();
          return;
        }
        if (!result.conflict) break; // Error no esperado, salir
      }

      // Si llegamos aquí, todos los tocayo-2..9 están ocupados
      this.toastService.error(`El alias "${baseAlias}" y sus variantes tocayo están ocupados. Por favor elige un alias completamente diferente.`);
    } catch {
      // Error de red: salir dejando el modo edición abierto para reintentar
    } finally {
      this.isSaving.set(false);
    }
  }
}
