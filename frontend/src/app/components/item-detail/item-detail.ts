import { Component, input, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { eventStatusBadge, eventStatusLabel } from '../../utils/event-status';
import { roleDisplayName, roleExpiryConsequence } from '../../utils/role-info';

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
  readonly toastService = inject(ToastService);

  readonly shareLink = signal<string | null>(null);
  readonly shareVisible = signal(false);

  /** Bindings de utilidades de estado de evento para la plantilla. */
  readonly eventStatusLabel = eventStatusLabel;
  readonly eventStatusBadge = eventStatusBadge;
  readonly roleDisplayName = roleDisplayName;
  readonly roleExpiryConsequence = roleExpiryConsequence;

  // Tick de 1s para las cuentas regresivas en vivo (se limpia al cerrar el modal).
  private tickTimer: number | null = null;
  readonly now = signal(Date.now());

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
      this.shareLink.set(`${window.location.origin}/events/${eventId}/invite/${data.code}`);
      this.shareVisible.set(true);
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    }
  }

  copyShareLink(): void {
    const link = this.shareLink();
    if (!link) return;
    navigator.clipboard?.writeText(link).then(
      () => this.toastService.success('Link copiado.'),
      () => this.toastService.error('No se pudo copiar.')
    );
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

  async onClaimItem(): Promise<void> {
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
      this.toastService.success(response.message || '¡Acción registrada con éxito!');
      this.close();
    } catch (err: any) {
      this.toastService.error(`Error al reclamar: ${err.message}`);
    }
  }
}
