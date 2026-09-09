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
import { CategoryEsPipe } from '../../pipes/category-es.pipe';
import { InventoryService, ItemWithQueue, QueueEntry } from '../../services/inventory';
import { UserService } from '../../services/user';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { eventStatusBadge, eventStatusLabel, phaseBadge, phaseLabel, claimStateEmoji, claimStateLabel } from '../../utils/event-status';
import { roleDisplayName, roleExpiryConsequence } from '../../utils/role-info';
import {
  buildInviteUrl,
  copyText,
  tryNativeShare,
  buildWhatsAppInviteUrl
} from '../../utils/invite-share';

/** Pestañas disponibles en el detalle del objeto. */
type DetailTab = 'datos' | 'tiempos' | 'condiciones';

/** Modo del diálogo de confirmación de apartado/captura. */
type ClaimConfirmMode = 'fifo_first' | 'free_window';

/** Renglón del calendario fijo v2 (V1..V3 / ventana libre / caridad). */
interface FixedTimelineRow {
  key: 'v1' | 'v2' | 'v3' | 'ventana' | 'caridad';
  label: string;
  icon: string;
  date: string | null;
  /** 'past' ya venció · 'now' es el corte activo · 'future' por venir · null sin fecha. */
  state: 'past' | 'now' | 'future' | null;
}

@Component({
  selector: 'app-item-detail',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe, DateEsPipe, CategoryEsPipe],
  templateUrl: './item-detail.html'
})
export class ItemDetail implements OnInit, OnDestroy {
  readonly item = input.required<ItemWithQueue>();
  readonly onClose = input.required<() => void>();
  /** true cuando el modal se abre en el área admin: cola forense completa y sin UI de visitante. */
  readonly adminMode = input(false);

  readonly inventoryService = inject(InventoryService);
  readonly userService = inject(UserService);
  readonly toastService = inject(ToastService);
  readonly adminTokenService = inject(AdminTokenService);
  /** Inyector del componente para ejecutar afterNextRender desde el effect. */
  private readonly injector = inject(Injector);

  readonly shareLink = signal<string | null>(null);
  readonly shareVisible = signal(false);
  /** Diálogo de confirmación previa al apartado (FIFO primer lugar) o captura de ventana libre. */
  readonly isConfirmingClaim = signal(false);
  readonly claimConfirmMode = signal<ClaimConfirmMode | null>(null);
  /** Diálogo de peligro al salir voluntariamente de la lista (visitante). */
  readonly isConfirmingLeave = signal(false);
  /** Diálogo de peligro al expulsar (admin): apodo objetivo de la cola. */
  readonly isConfirmingEvict = signal(false);
  readonly evictTarget = signal<QueueEntry | null>(null);

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

  /** Bindings de utilidades para la plantilla. */
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;
  readonly phaseLabel = phaseLabel;
  readonly phaseBadge = phaseBadge;
  readonly claimStateEmoji = claimStateEmoji;
  readonly claimStateLabel = claimStateLabel;
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

  // ---------------------------------------------------------------------------
  // Estado v2 del item (fase / estado temporal compacto / cola)
  // ---------------------------------------------------------------------------

  /** Fase v2 del artículo. */
  phase(): string {
    return this.item().phase ?? 'claim_open';
  }

  /** `estado_actual` compacto (CLAIM_ABIERTO/TURNO_N/VENTANA_LIBRE/ENTREGADO/...). */
  temporalCode(): string | null {
    return this.item().temporalState?.estado_actual ?? null;
  }

  /** Segundos restantes del estado activo (turno/ventana) según el feed. */
  activeSeconds(): number | null {
    return this.item().temporalState?.tiempo_restante_turno_activo_segundos ?? null;
  }

  /** Claims ACTIVOS de la cola, ordenados por posición FIFO (nulls last) y luego claimed_at. */
  activeClaims(): QueueEntry[] {
    const queue = this.item().queue ?? [];
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
  activeHolder(): QueueEntry | null {
    return this.activeClaims()[0] ?? null;
  }

  /** Mi claim ACTIVO en este item (o null). */
  myActiveClaim(): QueueEntry | null {
    const myUuid = this.userService.currentUuid();
    if (!myUuid) return null;
    return (this.item().queue ?? []).find(
      (c) => c.userUuid === myUuid && c.claimState === 'active'
    ) ?? null;
  }

  /** ¿El usuario autenticado está (activamente) en la cola de este objeto? */
  isUserInItemQueue(): boolean {
    return !!this.myActiveClaim();
  }

  /** Mi posición FIFO (1..3) o null si no estoy activo. */
  myFifoPosition(): number | null {
    const my = this.myActiveClaim();
    if (!my) return null;
    if (my.fifoPosition != null) return my.fifoPosition;
    const idx = this.activeClaims().findIndex((c) => c.id === my.id || c.userUuid === my.userUuid);
    return idx >= 0 ? idx + 1 : null;
  }

  /** ¿Soy el titular del turno activo (posición 1 / turno en curso)? */
  esTitularActivo(): boolean {
    const holder = this.activeHolder();
    const myUuid = this.userService.currentUuid();
    return !!holder && !!myUuid && holder.userUuid === myUuid;
  }

  /** ¿La cola está llena (3 activos)? */
  queueFull(): boolean {
    return this.activeClaims().length >= 3;
  }

  /** Fecha del turno activo (V del titular) o null. */
  activeTurnV(): string | null {
    return this.activeHolder()?.turnVExpiresAt ?? null;
  }

  // ---- Ventanas por rol (v2, dinámico puro) ----

  /** claims_close_at (T_inicio) del evento. */
  claimsCloseAt(): string | null {
    return this.item().eventSummary?.claims_close_at ?? null;
  }

  /** pickup_deadline (T_final / caridad) del evento. */
  pickupDeadline(): string | null {
    return this.item().eventSummary?.pickup_deadline ?? null;
  }

  /** Instante en que el rol puede empezar a reclamar (o null). */
  claimFromForRole(): string | null {
    return this.item().claimFromForRole ?? null;
  }

  // ---------------------------------------------------------------------------
  // Botones por fase/rol
  // ---------------------------------------------------------------------------

  /** ¿Puedo unirme a la FIFO (claim_open) o capturar (ventana libre) ahora? */
  canTakeAction(): boolean {
    const it = this.item();
    if (this.adminMode()) return false;
    if (it.phase === 'claim_open') {
      return (
        it.canClaim === true &&
        !this.isUserInItemQueue() &&
        !this.queueFull() &&
        !this.isClaimsClosed()
      );
    }
    if (it.phase === 'ventana_libre') {
      return it.canClaim === true && !this.isUserInItemQueue() && !this.isClaimsClosed();
    }
    return false;
  }

  /** Fase claim_open: mi ventana aún no abrió (antes de claimFromForRole). */
  notYetOpenForMe(): boolean {
    const from = this.claimFromForRole();
    const it = this.item();
    if (it.phase !== 'claim_open' || !this.userService.isAuthenticated()) return false;
    if (this.isUserInItemQueue()) return false;
    return !!from && new Date(from).getTime() > this.now();
  }

  /** El evento ya no acepta nuevas separaciones (claimsClosed / post T_inicio). */
  isClaimsClosed(): boolean {
    return this.item().claimsClosed === true;
  }

  /** Fase claim_open y el objeto está libre (nadie activo): al apartarlo seré 1º. */
  wouldBecomeFirst(): boolean {
    return (
      this.userService.isAuthenticated() &&
      this.phase() === 'claim_open' &&
      !this.isUserInItemQueue() &&
      this.activeClaims().length === 0 &&
      this.canTakeAction()
    );
  }

  /** Fase terminal: ya no hay acciones de visitante. */
  isTerminal(): boolean {
    const p = this.phase();
    return p === 'entregado' || p === 'enviado_a_caridad';
  }

  async onClaimItem(): Promise<void> {
    const it = this.item();
    if (it.phase === 'ventana_libre') {
      this.claimConfirmMode.set('free_window');
      this.isConfirmingClaim.set(true);
      return;
    }
    if (this.wouldBecomeFirst()) {
      this.claimConfirmMode.set('fifo_first');
      this.isConfirmingClaim.set(true);
      return;
    }
    await this.confirmClaim();
  }

  cancelConfirm(): void {
    this.isConfirmingClaim.set(false);
    this.claimConfirmMode.set(null);
  }

  /** Ejecuta el apartado (FIFO) o la captura de ventana libre (tras confirmar). */
  async confirmClaim(): Promise<void> {
    this.isConfirmingClaim.set(false);
    const mode = this.claimConfirmMode();
    this.claimConfirmMode.set(null);
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
      if (response?.delivered === true) {
        // Captura de ventana libre → entrega inmediata.
        this.toastService.success('🎉 ¡Te lo llevas! El artículo quedó marcado como entregado.');
      } else if (mode === 'free_window') {
        this.toastService.success(response?.message || '¡Reclamado! El artículo quedó entregado.');
      } else if (response?.queuePosition === 1) {
        this.toastService.success('🎉 ¡Eres primero en la fila! Te tocará recogerlo cuando empiecen los turnos.');
      } else {
        this.toastService.success(
          response?.message || `¡Apuntado! Quedaste en espera #${response?.queuePosition ?? ''}`.trim()
        );
      }
      this.close();
    } catch (err: any) {
      this.toastService.error(`Error al reclamar: ${err.message}`);
    }
  }

  /** ¿Muestra la X sobre un claim? Admin: solo activos (evicción). Visitante: solo mi claim activo. */
  canShowQueueX(claim: QueueEntry): boolean {
    if (claim.claimState !== 'active') return false;
    if (this.adminMode()) return true;
    return this.userService.isAuthenticated() && claim.userUuid === this.userService.currentUuid();
  }

  /** Tooltip contextual de un chip de la cola según rol (admin/visitante). */
  queueChipTitle(claimer: QueueEntry): string {
    if (this.adminMode()) {
      return `@${claimer.username} — ${claimStateLabel(claimer.claimState)}. Click ✕ para expulsarlo (solo si su turno está activo).`;
    }
    if (claimer.userUuid === this.userService.currentUuid() && claimer.claimState === 'active') {
      return '✅ ¡Eres tú! Estás en la lista. Click ✕ para salir (sin sanción).';
    }
    const pos = claimer.fifoPosition ?? null;
    return `En la lista${pos ? ` (posición #${pos})` : ''}`;
  }

  /** Click sobre la X de un claim: abre el diálogo de peligro correspondiente. */
  onQueueX(claimer: QueueEntry): void {
    if (claimer.claimState !== 'active') return;
    if (this.adminMode()) {
      this.evictTarget.set(claimer);
      this.isConfirmingEvict.set(true);
      return;
    }
    if (claimer.userUuid === this.userService.currentUuid()) {
      this.isConfirmingLeave.set(true);
    }
  }

  cancelLeave(): void {
    this.isConfirmingLeave.set(false);
  }

  cancelEvict(): void {
    this.isConfirmingEvict.set(false);
    this.evictTarget.set(null);
  }

  /** Confirma la salida voluntaria del visitante. Neutral para la confianza. */
  async confirmLeave(): Promise<void> {
    this.isConfirmingLeave.set(false);
    const item = this.item();
    const userUuid = this.userService.currentUuid();
    if (!userUuid) return;
    try {
      const response = await this.inventoryService.submitLeave(item.id, userUuid);
      this.toastService.success(response?.message || 'Saliste de la lista. Tu lugar quedó liberado.');
      // submitLeave ya refresca el feed; solo cerramos el card.
      this.close();
    } catch (err: any) {
      this.toastService.error(`Error al salir: ${err.message}`);
    }
  }

  /** Confirma la expulsión (admin). Envía el userUuid exacto del claim. */
  async confirmEvict(): Promise<void> {
    const target = this.evictTarget();
    this.cancelEvict();
    if (!target) return;
    const item = this.item();
    const token = this.adminTokenService.token();
    if (!token) return;
    try {
      await this.inventoryService.evictClaimant(item.id, target.userUuid, token);
      this.toastService.success(`@${target.username} fue retirado de la lista.`);
    } catch (err: any) {
      this.toastService.error(`Error al expulsar: ${err.message}`);
    } finally {
      // Recompone la cola en la vista admin (el backend ya emitió SSE).
      this.inventoryService.refreshAdminItems().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Compartir invitación (participantes) — solo visitante
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Pestaña "Tiempos" — línea temporal v2 (V1..V3 / ventana libre / caridad)
  // ---------------------------------------------------------------------------

  /**
   * ¿El item ya tiene calendario fijo (congelado)? El feed público lo expone en
   * `temporalState.linea_tiempo_fija`; el listado admin en `frozenSchedule`
   * (snapshot raw de `items.frozen_schedule`). Ambos son la misma línea fija.
   */
  hasFrozenTimeline(): boolean {
    const it = this.item();
    return !!it.frozenSchedule || !!it.temporalState?.linea_tiempo_fija;
  }

  /**
   * Renglones del calendario fijo para la pestaña Tiempos. Solo se construye
   * cuando existe el calendario congelado (item >= T_inicio); en claim_open
   * (pre congelamiento) aún no se fija y se muestra el cierre global.
   */
  fixedTimelineRows(): FixedTimelineRow[] {
    const it = this.item();
    const fs = it.frozenSchedule;
    const tl = it.temporalState?.linea_tiempo_fija;
    const src = fs
      ? {
          v1: fs.v1 ?? null,
          v2: fs.v2 ?? null,
          v3: fs.v3 ?? null,
          ventana: fs.ventana_libre_starts_at ?? null,
          caridad: fs.charity_at ?? null
        }
      : tl
        ? {
            v1: tl.vencimiento_posicion_1 ?? null,
            v2: tl.vencimiento_posicion_2 ?? null,
            v3: tl.vencimiento_posicion_3 ?? null,
            ventana: tl.ventana_libre ?? null,
            caridad: tl.caridad_final ?? null
          }
        : null;
    if (!src) return [];

    const phase = this.phase();
    const holderPos = this.activeHolder()?.fifoPosition ?? null;
    const code = this.temporalCode();
    const nowMs = this.now();

    const candidates: Array<{ key: FixedTimelineRow['key']; label: string; icon: string; date: string | null }> = [
      { key: 'v1', label: 'Turno 1 termina', icon: '👑', date: src.v1 },
      { key: 'v2', label: 'Turno 2 termina', icon: '⏳', date: src.v2 },
      { key: 'v3', label: 'Turno 3 termina', icon: '⏳', date: src.v3 },
      { key: 'ventana', label: 'Ventana libre', icon: '🔥', date: src.ventana },
      { key: 'caridad', label: 'Envío a caridad', icon: '🏁', date: src.caridad }
    ];

    return candidates
      .filter((r) => r.date != null)
      .map((r) => {
        const ms = new Date(r.date as string).getTime();
        let state: FixedTimelineRow['state'] = ms <= nowMs ? 'past' : 'future';
        // Marcar el corte "activo" según el estado actual.
        if (code?.startsWith('TURNO_') && holderPos != null) {
          const activeKey = (holderPos === 1 ? 'v1' : holderPos === 2 ? 'v2' : 'v3') as FixedTimelineRow['key'];
          if (r.key === activeKey) state = 'now';
        } else if (phase === 'ventana_libre' && r.key === 'ventana') {
          state = ms <= nowMs ? 'now' : 'future';
        } else if (phase === 'entregado' && r.key === 'caridad') {
          state = 'past';
        } else if (phase === 'enviado_a_caridad' && r.key === 'caridad') {
          state = 'now';
        }
        return { ...r, state } as FixedTimelineRow;
      });
  }

  /**
   * Cola a mostrar según contexto: visitante → solo claims ACTIVOS (en orden de
   * turno); admin → cola forense completa (todos los claim_state).
   */
  queueChips(): QueueEntry[] {
    return this.adminMode() ? (this.item().queue ?? []) : this.activeClaims();
  }
}
