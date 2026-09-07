import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UserService } from '../../services/user';
import { InventoryService } from '../../services/inventory';
import { InvitationService } from '../../services/invitations';
import { ToastService } from '../../services/toast';

/**
 * Puerta de bienvenida para invitaciones que ELEVAN por encima de 'publico'.
 *
 * Solo bloquea al visitante ANÓNIMO (sin sesión guardada): se muestra un popup
 * obligatorio con el título del evento y un campo único de apodo (pre-llenado y
 * editable con el valor opcional ?apodo= que el anfitrión pudo sugerir). Al
 * confirmar ("Unirme") se da de alta la sesión y se acepta la invitación
 * persistida, garantizando que el usuario quede con el nivel invitado sin
 * importar recargas.
 *
 * Reglas:
 *  - Ya identificado → no bloquea (la aceptación silenciosa la hace
 *    inventory-list).
 *  - Sin invitación, o invitación de rol 'publico' → no bloquea (navegación
 *    normal).
 *  - No se puede cerrar sin completar el alta (pantalla bloqueada).
 */
@Component({
  selector: 'app-invite-welcome',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './invite-welcome.html'
})
export class InviteWelcome implements OnInit {
  private readonly userService = inject(UserService);
  private readonly inventoryService = inject(InventoryService);
  private readonly invitationService = inject(InvitationService);
  private readonly toastService = inject(ToastService);

  /** Popup visible (pantalla bloqueada). */
  readonly visible = signal(false);
  /** true mientras se resuelve la invitación o se guarda el apodo. */
  readonly loading = signal(false);
  readonly eventTitle = signal('');
  readonly apodo = signal('');
  /** Error inline (p. ej. apodo ya en uso). */
  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    await this.evaluate();
  }

  /** Decide si la invitación pendiente amerita bloquear con el popup. */
  private async evaluate(): Promise<void> {
    // Ya identificado: la aceptación silenciosa la maneja inventory-list.
    if (this.userService.isAuthenticated()) return;
    if (!this.invitationService.hasPending()) return;

    this.loading.set(true);
    const resolved = await this.invitationService.resolvePending();
    this.loading.set(false);

    if (!resolved) return; // sin pendiente (ya se consumió)

    if (!resolved.valid) {
      if (resolved.network) return; // no sabemos el rol → sin puerta, token conservado
      // Código inválido/inactivo (ya descartado por el servicio): aviso no bloqueante.
      this.toastService.info(
        'El enlace de invitación ya no es válido. Pide uno nuevo; mientras tanto puedes navegar el catálogo.'
      );
      return;
    }

    // Invitación que no eleva (publico): no hay necesidad de registrar → sin puerta.
    if (resolved.role === 'publico') return;

    // Eleva por encima de 'publico' → bloquear con el popup de bienvenida.
    this.eventTitle.set(resolved.eventTitle || 'este evento');
    this.apodo.set(this.invitationService.suggestedAlias() ?? '');
    this.error.set('');
    this.visible.set(true);
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('#invite-welcome-alias');
      el?.focus();
    }, 0);
  }

  /** Alta de sesión + aceptación de la invitación. Nunca sin clic del invitado. */
  async onJoin(): Promise<void> {
    if (this.loading()) return; // evita doble envío (botón + Enter)
    const alias = this.apodo().trim();
    if (!alias) {
      this.error.set('Ingresa un apodo o alias para continuar.');
      return;
    }

    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.userService.resolveSession(alias, null, null);
      if (result.conflict) {
        // Alias ocupado: error inline editable; el token se conserva.
        this.error.set(
          `El apodo "@${result.storedAlias ?? alias}" ya está en uso. Elige otro.`
        );
        return;
      }

      const uuid = this.userService.currentUuid();
      const accept = await this.invitationService.acceptPending(uuid);
      if (accept.accepted) {
        if (accept.role) this.userService.setRole(accept.role);
        this.toastService.success('🎉 ¡Bienvenido al evento!');
        this.inventoryService.refresh().catch(() => {});
      } else if (accept.invalid) {
        this.toastService.info(
          'El enlace de invitación ya no es válido. Pide uno nuevo; mientras tanto puedes navegar el catálogo.'
        );
      } else {
        // Fallo de red: el token queda persistido y el usuario ya quedó
        // identificado. Reintentar en silencio una vez en breve; si vuelve a
        // fallar, la próxima apertura (inventory-list) lo reintenta.
        this.toastService.info('Ya quedaste registrado; tu invitación se aplicará en un momento.');
        setTimeout(() => {
          if (this.userService.isAuthenticated() && this.invitationService.hasPending()) {
            this.invitationService
              .acceptPending(this.userService.currentUuid())
              .then(retry => {
                if (retry.accepted) {
                  if (retry.role) this.userService.setRole(retry.role);
                  this.inventoryService.refresh().catch(() => {});
                }
              })
              .catch(() => {});
          }
        }, 1500);
      }

      this.visible.set(false);
    } catch (err: any) {
      this.error.set(err?.message || 'No se pudo completar el alta. Inténtalo de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }
}
