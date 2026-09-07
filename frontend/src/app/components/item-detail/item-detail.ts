import {
  Component,
  input,
  inject,
  signal,
  OnInit,
  OnDestroy,
  ElementRef,
  viewChild,
  effect,
  afterNextRender,
  Injector,
  runInInjectionContext
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { formatDateEs } from '../../utils/date-es';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { eventStatusBadge, eventStatusLabel } from '../../utils/event-status';
import { roleDisplayName, roleExpiryConsequence } from '../../utils/role-info';
import {
  buildInviteUrl,
  copyText,
  tryNativeShare,
  buildWhatsAppInviteUrl
} from '../../utils/invite-share';

/** Pestañas disponibles en el detalle del objeto. */
type DetailTab = 'datos' | 'tiempos' | 'condiciones';

@Component({
  selector: 'app-item-detail',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe, DateEsPipe],
  templateUrl: './item-detail.html'
})
export class ItemDetail {
  readonly item = input.required<ItemWithQueue>();
  readonly onClose = input.required<() => void>();

  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);
  readonly toastService = inject(ToastService);
  /** Inyector del componente para ejecutar afterNextRender desde el effect. */
  private readonly injector = inject(Injector);

  readonly shareLink = signal<string | null>(null);
  readonly shareVisible = signal(false);
  /** Diálogo de confirmación previa al apartado (preflight, Fase 5). */
  readonly isConfirmingClaim = signal(false);

  // ---- Galería de fotos (arreglo imageUrls, portada = índice 0) ----
  /** Foto ampliada activa (índice dentro de imageUrls). */
  readonly selectedPhoto = signal(0);

  // ---- Pestañas (Datos / Tiempos / Condiciones) ----
  /** Pestaña activa; 'Datos' es la inicial y la referencia de altura del área de tabs. */
  readonly activeTab = signal<DetailTab>('datos');
  /** Altura fija del área de tabs = alto natural de 'Datos' (con mínimo cómodo). */
  readonly tabAreaHeight = signal<number | null>(null);
  /** Altura mínima del área para que el card no se vea diminuto si 'Datos' es corto. */
  readonly minTabAreaHeight = 220;
  /** Contenedor del área de tabs (para medir su alto natural tras el primer render). */
  readonly tabBody = viewChild<ElementRef<HTMLDivElement>>('tabBody');

  /** Bindings de utilidades de estado de evento para la plantilla. */
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;
  readonly roleDisplayName = roleDisplayName;
  readonly roleExpiryConsequence = roleExpiryConsequence;

  // Tick de 1s para las cuentas regresivas en vivo (se limpia al cerrar el modal).
  private tickTimer: number | null = null;
  readonly now = signal(Date.now());

  constructor() {
    // Reinicia la primera pestaña (y reprograma la medición) al abrir el card, o
    // defensivamente si `item` cambiara dentro de la misma instancia del modal.
    effect(() => {
      this.item();
      this.activeTab.set('datos');
      // Cada vez que cambia el objeto se vuelve a la primera foto (portada).
      this.selectedPhoto.set(0);
      this.tabAreaHeight.set(null);
      // afterNextRender exige un contexto de inyección, pero el callback de un
      // effect NO lo es (lanza NG0203 y aborta el primer render del card).
      // Se envuelve con runInInjectionContext para medir tras el primer paint.
      runInInjectionContext(this.injector, () => {
        afterNextRender(() => this.lockTabAreaHeight());
      });
    });
  }

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    this.tickTimer = window.setInterval(() => this.now.set(Date.now()), 1000);
  }

  ngOnDestroy(): void {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Cambia la pestaña activa del detalle. */
  selectTab(tab: DetailTab): void {
    this.activeTab.set(tab);
  }

  /** Arreglo de fotos del Item (con respaldo defensivo si falta). */
  photoUrls(): string[] {
    return this.item().imageUrls?.length ? this.item().imageUrls : [];
  }

  /** URL de la foto ampliada activa (clamp al rango del arreglo). */
  mainPhotoUrl(): string {
    const urls = this.photoUrls();
    const idx = Math.min(this.selectedPhoto(), Math.max(urls.length - 1, 0));
    return urls[idx] ?? '';
  }

  /** Cambia la foto ampliada pulsando un thumbnail. */
  selectPhoto(i: number): void {
    const urls = this.photoUrls();
    if (i >= 0 && i < urls.length) this.selectedPhoto.set(i);
  }

  /** ¿Hay más de una foto (para mostrar la franja de thumbnails)? */
  hasMultiplePhotos(): boolean {
    return this.photoUrls().length > 1;
  }

  /** ¿Aplican límites/consecuencias para el usuario actual en este evento? */
  hasLimits(): boolean {
    return (
      this.userService.isAuthenticated() &&
      !!this.item().eventSummary &&
      !!this.item().myRoleInEvent
    );
  }

  /**
   * Fija la altura del área de tabs al alto natural de la pestaña 'Datos'
   * (con un mínimo cómodo). Así el card no cambia de tamaño al alternar
   * pestañas y 'Tiempos'/'Condiciones' solo hacen scroll interno si exceden.
   */
  private lockTabAreaHeight(): void {
    if (this.tabAreaHeight() !== null) return;
    const el = this.tabBody()?.nativeElement;
    if (!el) return;
    const natural = el.offsetHeight;
    if (natural > 0) {
      // +1 px evita un scrollbar fantasma por redondeo de subpíxeles.
      this.tabAreaHeight.set(Math.max(natural + 1, this.minTabAreaHeight));
    } else {
      // El layout aún no está listo; reintenta tras el siguiente render.
      afterNextRender(() => this.lockTabAreaHeight());
    }
  }

  /** Cuenta regresiva legible hacia `target` (ISO), o '' si no aplica o ya venció. */
  countdown(target: string | null | undefined): string {
    if (!target) return '';
    const diff = new Date(target).getTime() - this.now();
    if (diff <= 0) return '';
    const totalMin = Math.floor(diff / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const minutes = totalMin % 60;
    const seconds = Math.floor((diff % 60000) / 1000);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  /** Posición (1-based) del usuario en la cola, o null si no está. */
  myWaitPosition(): number | null {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return null;
    const idx = this.item().queue.findIndex(q => q.userUuid === myUuid);
    return idx >= 0 ? idx + 1 : null;
  }

  close(): void {
    this.onClose()();
  }

  /** El usuario puede invitar si está en un evento y no es público. */
  canShare(): boolean {
    return (
      this.userService.isAuthenticated() &&
      !!this.item().eventId &&
      this.userService.currentRole() !== 'publico'
    );
  }

  /** ¿El usuario autenticado es el primero en la fila? */
  esPrimeroEnFila(): boolean {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return false;
    return this.item().queue.length > 0 && this.item().queue[0].userUuid === myUuid;
  }

  /** Disponible para reclamar para el usuario (canClaim del feed; legacy = true). */
  isAvailableForMe(): boolean {
    return this.item().canClaim !== false;
  }

  /** El evento ya no acepta nuevas separaciones (closing/closed). */
  isClaimsClosed(): boolean {
    return this.item().claimsClosed === true;
  }

  async onShare(): Promise<void> {
    const eventId = this.item().eventId;
    const userUuid = this.userService.currentUuid();
    if (!eventId || !userUuid) return;
    try {
      const res = await fetch(
        `${railwayApiUrl}/events/${eventId}/share-link?userUuid=${encodeURIComponent(userUuid)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo generar el link.');
      // Enlace completo: HOME + token (https://SITIO/?invite=CODE)
      this.shareLink.set(buildInviteUrl(data.code));
      this.shareVisible.set(true);
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }

  async copyShareLink(): Promise<void> {
    const link = this.shareLink();
    if (!link) return;
    const ok = await copyText(link);
    this.toastService[ok ? 'success' : 'error'](ok ? 'Enlace copiado.' : 'No se pudo copiar.');
  }

  async shareShareLink(): Promise<void> {
    const link = this.shareLink();
    if (!link) return;
    const shared = await tryNativeShare(link);
    if (!shared) {
      const ok = await copyText(link);
      this.toastService[ok ? 'success' : 'error'](
        ok ? 'Enlace copiado (pégalo en WhatsApp).' : 'No se pudo copiar.'
      );
    }
  }

  whatsAppShareUrl(): string {
    const link = this.shareLink();
    return link ? buildWhatsAppInviteUrl(link) : '#';
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

  /** ¿Al apartar este objeto quedaría PRIMERO en la fila (objeto libre)? */
  wouldBecomeFirst(): boolean {
    return (
      this.userService.isAuthenticated() &&
      !this.isUserInItemQueue() &&
      this.item().status === 'available' &&
      this.isAvailableForMe() &&
      !this.isClaimsClosed()
    );
  }

  async onClaimItem(): Promise<void> {
    if (this.wouldBecomeFirst()) {
      this.isConfirmingClaim.set(true);
      return;
    }
    await this.confirmClaim();
  }

  cancelConfirm(): void {
    this.isConfirmingClaim.set(false);
  }

  /** Ejecuta el apartado (tras la confirmación preflight cuando aplica). */
  async confirmClaim(): Promise<void> {
    this.isConfirmingClaim.set(false);
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
      if (response?.queuePosition === 1 && (response.pickupDeadline || item.myPickupDeadline)) {
        const deadline = response.pickupDeadline || item.myPickupDeadline;
        this.toastService.success(
          `🎉 ¡Eres primero en la fila! Recoge antes de ${formatDateEs(deadline, {
            withWeekday: false,
            withYear: true,
            withDay: true,
            withTime: true
          })}.`
        );
      } else {
        this.toastService.success(response.message || '¡Acción registrada con éxito!');
      }
      this.close();
    } catch (err: any) {
      this.toastService.error(`Error al reclamar: ${err.message}`);
    }
  }
}
