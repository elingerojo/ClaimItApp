import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { UserService } from '../../services/user';
import { ToastService } from '../../services/toast';
import { InventoryService } from '../../services/inventory';
import { railwayApiUrl } from '../../app.config';

type InviteState = 'loading' | 'ready' | 'error' | 'joined';

@Component({
  selector: 'app-event-invitation',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
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
          this.joining.set(false);
          return;
        }
        const result = await this.userService.resolveSession(alias, null, null);
        if (result.conflict) {
          this.toastService.error('Ese alias ya está en uso. Elige otro.');
          this.joining.set(false);
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
      this.joining.set(false);
    }
  }
}
