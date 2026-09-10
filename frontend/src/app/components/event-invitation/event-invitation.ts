import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { UserService, StoredUserProfile } from '../../services/user';
import { ToastService } from '../../services/toast';
import { InventoryService } from '../../services/inventory';
import { InviteRecovery } from '../invite-recovery/invite-recovery';
import type { RecoveryChoice } from '../invite-recovery/invite-recovery';
import { isInAppWebview } from '../../utils/browser-context';
import { railwayApiUrl } from '../../app.config';

type InviteState = 'loading' | 'ready' | 'error' | 'joined';

@Component({
  selector: 'app-event-invitation',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, InviteRecovery],
  templateUrl: './event-invitation.html'
})
export class EventInvitation implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly userService = inject(UserService);
  readonly toastService = inject(ToastService);
  private readonly inventoryService = inject(InventoryService);
  private readonly apiUrl = railwayApiUrl;

  readonly state = signal<InviteState>('loading');
  readonly eventTitle = signal('');
  readonly role = signal('');
  readonly inviterAlias = signal('');
  readonly errorMsg = signal('');
  readonly alias = signal('');
  readonly joining = signal(false);

  // Tercera pantalla: recuperación de identidad ante conflicto de apodo.
  readonly recoveryVisible = signal(false);
  readonly recoveryAlias = signal('');
  readonly recoveryEmphasized = signal<RecoveryChoice>('new');
  readonly showWebviewHint = signal(false);

  private pendingStoredUser: StoredUserProfile | null = null;

  readonly roleLabels: Record<string, string> = {
    familiares: '👨‍👩‍👧‍👦 Familiares',
    amigos: '🤝 Amigos',
    conocidos: '👋 Conocidos',
    publico: '🌐 Público'
  };

  private eventId = '';
  private code = '';

  ngOnInit(): void {
    this.eventId = this.route.snapshot.paramMap.get('id') || '';
    this.code = this.route.snapshot.paramMap.get('code') || '';
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/events/${this.eventId}/invite/${this.code}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invitación inválida o expirada.');
      this.eventTitle.set(data.eventTitle);
      this.role.set(data.role);
      this.inviterAlias.set(data.inviterAlias || 'el anfitrión');
      this.state.set('ready');
    } catch (err: any) {
      this.errorMsg.set(err.message);
      this.state.set('error');
    }
  }

  async onJoin(): Promise<void> {
    this.joining.set(true);
    try {
      // Asegurar sesión (alias) si el usuario no está autenticado
      let uuid = this.userService.currentUuid();
      if (!uuid) {
        const alias = this.alias().trim();
        if (!alias) {
          this.toastService.error('Ingresa un apodo o alias para continuar.');
          return;
        }
        const result = await this.userService.resolveSession(alias, null, null);
        if (result.conflict) {
          // 409: abrir la tercera pantalla de recuperación en lugar de solo avisar.
          this.openRecovery(alias, result.storedAlias ?? alias, result.storedUser ?? null);
          return;
        }
        uuid = this.userService.currentUuid();
      }

      const res = await fetch(`${this.apiUrl}/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationCode: this.code, userUuid: uuid })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo unir al evento.');

      // Si el rol subió, actualizar la sesión local
      if (data.role) this.userService.setRole(data.role);
      this.inventoryService.refresh().catch(() => {});
      this.state.set('joined');
      this.toastService.success(data.message || '¡Te uniste al evento!');
      this.router.navigate(['/']);
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.joining.set(false);
    }
  }

  /** Abre la tercera pantalla contra el apodo en conflicto. */
  private openRecovery(
    ingresado: string,
    storedAlias: string,
    storedUser: StoredUserProfile | null
  ): void {
    this.pendingStoredUser = storedUser;
    this.recoveryAlias.set(storedAlias || ingresado);
    // Énfasis guiado por contexto: en webview in-app es probable que la
    // identidad se haya creado por separado → enfatizar "ese apodo es mío".
    const emphasized: RecoveryChoice = isInAppWebview() ? 'existing' : 'new';
    this.recoveryEmphasized.set(emphasized);
    this.showWebviewHint.set(emphasized === 'existing');
    this.recoveryVisible.set(true);
  }

  /** Rama A: es su primera vez → volver al alias con foco y sugerir tocayo-2. */
  onRecoveryChooseNew(): void {
    this.recoveryVisible.set(false);
    this.pendingStoredUser = null;
    const base = this.recoveryAlias();
    this.alias.set(base ? `${base}-tocayo-2` : '');
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('#event-invite-alias');
      el?.focus();
      el?.select();
    }, 0);
  }

  /** Rama B: el apodo es suyo → adoptar el perfil existente y reintentar. */
  async onRecoveryClaimExisting(): Promise<void> {
    const stored = this.pendingStoredUser;
    if (!stored) {
      this.onRecoveryChooseNew();
      return;
    }
    this.userService.adoptStoredUser(stored);
    this.pendingStoredUser = null;
    this.recoveryVisible.set(false);
    await this.onJoin();
  }

  /** Verdadero si la invitación trae el alias real de quién invita (handle @alias).
   *  En caso contrario se muestra el texto decorativo "el anfitrión". */
  inviterIsHandle(): boolean {
    const a = this.inviterAlias();
    return !!a && a !== 'el anfitrión';
  }
}
