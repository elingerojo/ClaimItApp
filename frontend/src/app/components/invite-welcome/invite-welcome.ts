import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UserService, StoredUserProfile } from '../../services/user';
import { InventoryService } from '../../services/inventory';
import { InvitationService } from '../../services/invitations';
import { ToastService } from '../../services/toast';
import { InviteRecovery } from '../invite-recovery/invite-recovery';
import type { RecoveryChoice } from '../invite-recovery/invite-recovery';
import { isInAppWebview } from '../../utils/browser-context';

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
 * Si el apodo ya está ocupado (409) se muestra la tercera pantalla de
 * recuperación (InviteRecovery) en lugar de un error inline sin salida:
 *   - "Es mi primera vez"  → volver al alias con foco y sugerir una variante.
 *   - "Ese apodo es mío"   → adoptar el perfil existente y continuar la invitación.
 * El énfasis de las opciones se guía con la detección de webview in-app.
 *
 * Reglas:
 *  - Ya identificado → no bloquea (la aceptación silenciosa la hace
 *    inventory-list).
 *  - Sin invitación, o invitación de rol 'publico' → no bloquea (navegación
 *    normal).
 *  - El invitado puede posponer la invitación ("Ahora no") sin quedar atrapado.
 */
@Component({
  selector: 'app-invite-welcome',
  standalone: true,
  imports: [FormsModule, InviteRecovery],
  templateUrl: './invite-welcome.html'
})
export class InviteWelcome implements OnInit {
  private readonly userService = inject(UserService);
  private readonly inventoryService = inject(InventoryService);
  private readonly invitationService = inject(InvitationService);
  private readonly toastService = inject(ToastService);

  /** Popup visible. */
  readonly visible = signal(false);
  /** true mientras se resuelve la invitación o se guarda el apodo. */
  readonly loading = signal(false);
  readonly eventTitle = signal('');
  readonly apodo = signal('');
  /** Error inline (p. ej. apodo ya en uso). */
  readonly error = signal('');

  // Tercera pantalla: recuperación de identidad ante conflicto de apodo.
  readonly recoveryVisible = signal(false);
  readonly recoveryAlias = signal('');
  readonly recoveryEmphasized = signal<RecoveryChoice>('new');
  readonly showWebviewHint = signal(false);

  private pendingStoredUser: StoredUserProfile | null = null;
  private conflictedAlias = '';
  /** El invitado pospuso la invitación en esta sesión (no volver a bloquear). */
  private dismissed = false;

  async ngOnInit(): Promise<void> {
    await this.evaluate();
  }

  /** Decide si la invitación pendiente amerita bloquear con el popup. */
  private async evaluate(): Promise<void> {
    if (this.dismissed) return;
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
        // 409: abrir la tercera pantalla de recuperación.
        this.openRecovery(alias, result.storedAlias ?? alias, result.storedUser ?? null);
        return;
      }
      await this.completeJoin();
    } catch (err: any) {
      this.error.set(err?.message || 'No se pudo completar el alta. Inténtalo de nuevo.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Abre la tercera pantalla contra el apodo en conflicto. */
  private openRecovery(
    ingresado: string,
    storedAlias: string,
    storedUser: StoredUserProfile | null
  ): void {
    this.pendingStoredUser = storedUser;
    this.conflictedAlias = ingresado;
    this.recoveryAlias.set(storedAlias || ingresado);
    // El énfasis se guía por el contexto de navegación: en webview in-app es
    // probable que la identidad se haya creado por separado → enfatizar "es mío".
    const emphasized: RecoveryChoice = isInAppWebview() ? 'existing' : 'new';
    this.recoveryEmphasized.set(emphasized);
    this.showWebviewHint.set(emphasized === 'existing');
    this.error.set('');
    this.recoveryVisible.set(true);
  }

  /** Rama A: es su primera vez → volver al alias con foco y sugerir tocayo-2. */
  onRecoveryChooseNew(): void {
    this.recoveryVisible.set(false);
    this.pendingStoredUser = null;
    const base = this.recoveryAlias() || this.conflictedAlias;
    this.apodo.set(base ? `${base}-tocayo-2` : '');
    this.error.set('Ese apodo ya está en uso. Te sugerimos una variante; puedes editarla.');
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('#invite-welcome-alias');
      el?.focus();
      el?.select();
    }, 0);
  }

  /** Rama B: el apodo es suyo → adoptar el perfil existente y continuar. */
  async onRecoveryClaimExisting(): Promise<void> {
    const stored = this.pendingStoredUser;
    if (!stored) {
      // Sin perfil no se puede adoptar; ofrecer elegir otro apodo.
      this.onRecoveryChooseNew();
      return;
    }
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      this.userService.adoptStoredUser(stored);
      this.pendingStoredUser = null;
      this.recoveryVisible.set(false);
      await this.completeJoin();
    } catch (err: any) {
      this.error.set(err?.message || 'No se pudo continuar con tu apodo.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Posponer la invitación sin re-bloquear (el pendiente queda persistido). */
  dismiss(): void {
    this.dismissed = true;
    this.visible.set(false);
    this.recoveryVisible.set(false);
  }

  /** Acepta la invitación pendiente y cierra el gate. */
  private async completeJoin(): Promise<void> {
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
  }
}
