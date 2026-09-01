import { Component, input, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { InventoryService, ItemWithQueue } from '../../services/inventory';
import { UserService } from '../../services/user';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';

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
