import { Component, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { AdminAuth } from '../admin-auth/admin-auth';

/** Fila editable de la matriz por rol (valores numéricos en horas). */
export interface RoleRow {
  id: string;
  advance: number; // anticipación (horas antes de available_from)
  bonus: number; // bonus por referido (horas)
  pickup: number; // ventana de recogida (horas)
  multiplier: number | null; // read-only (precio)
  maxApartados: number | null; // read-only (apartados simultáneos)
}

/** Plantilla de agenda global (event_config id=1). */
export interface AgendaConfig {
  open_after_publish_hours: number;
  claims_window_hours: number;
  closing_window_hours: number;
  pickup_schedule_info: string | null;
}

export const ROLE_LABELS: Record<string, string> = {
  familiares: '👨‍👩‍👧‍👦 Familiares',
  amigos: '🤝 Amigos',
  conocidos: '👋 Conocidos',
  publico: '🌐 Público'
};

@Component({
  selector: 'app-admin-config',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, AdminAuth],
  templateUrl: './admin-config.html'
})
export class AdminConfig {
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);
  private readonly apiUrl = railwayApiUrl;

  readonly roles = signal<RoleRow[]>([]);
  readonly agenda = signal<AgendaConfig | null>(null);
  readonly loading = signal(false);
  readonly savingRoles = signal(false);
  readonly savingAgenda = signal(false);

  readonly roleLabels = ROLE_LABELS;
  private bootstrapped = false;

  constructor() {
    // Al autenticarse (o al llegar ya autenticado) cargamos ambas
    // configuraciones; al cerrar sesión se limpia el estado.
    effect(() => {
      const authed = this.adminTokenService.authenticated();
      if (!authed) {
        this.bootstrapped = false;
        return;
      }
      if (this.bootstrapped) return;
      this.bootstrapped = true;
      void this.load();
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const token = this.adminTokenService.token();
      const [rolesRes, agendaRes] = await Promise.all([
        fetch(`${this.apiUrl}/admin/role-config`, {
          headers: { 'X-Admin-Token': token }
        }),
        fetch(`${this.apiUrl}/admin/event-config`, {
          headers: { 'X-Admin-Token': token }
        })
      ]);

      if (!rolesRes.ok || !agendaRes.ok) {
        const body = rolesRes.ok ? await agendaRes.json() : await rolesRes.json();
        throw new Error(body?.error || 'No autorizado o configuración no encontrada.');
      }

      const rolesData = await rolesRes.json();
      const agendaData = await agendaRes.json();

      this.roles.set(
        (rolesData.roles ?? []).map((r: any) => ({
          id: r.id,
          advance: r.advance_hours_default != null ? Number(r.advance_hours_default) : 0,
          bonus: r.share_bonus_default != null ? Number(r.share_bonus_default) : 0,
          pickup: r.intervalo_recoleccion_horas_default != null
            ? Number(r.intervalo_recoleccion_horas_default)
            : 0,
          multiplier: r.multiplicador_precio_default != null
            ? Number(r.multiplicador_precio_default)
            : null,
          maxApartados: r.max_apartados_simultaneos != null
            ? Number(r.max_apartados_simultaneos)
            : null
        }))
      );

      const c = agendaData.config ?? {};
      this.agenda.set({
        open_after_publish_hours: Number(c.open_after_publish_hours),
        claims_window_hours: Number(c.claims_window_hours),
        closing_window_hours: Number(c.closing_window_hours),
        pickup_schedule_info: c.pickup_schedule_info ?? null
      });
    } catch (err: any) {
      this.toastService.error(`Error al cargar configuración: ${err.message}`);
    } finally {
      this.loading.set(false);
    }
  }

  /** Guarda las ventajas por rol editables (advance/bonus/recogida). */
  async saveRoles(): Promise<void> {
    const roles: Record<string, any> = {};
    for (const row of this.roles()) {
      roles[row.id] = {
        advance_hours_default: Number(row.advance),
        share_bonus_default: Number(row.bonus),
        intervalo_recoleccion_horas_default: Number(row.pickup)
      };
    }

    this.savingRoles.set(true);
    try {
      const res = await fetch(`${this.apiUrl}/admin/role-config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({ config: { roles } })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Error al guardar ventajas por rol.');
      this.toastService.success('Ventajas por rol actualizadas.');
      // Refrescar valores normalizados desde el server.
      await this.load();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.savingRoles.set(false);
    }
  }

  /** Guarda la plantilla de agenda. */
  async saveAgenda(): Promise<void> {
    const agenda = this.agenda();
    if (!agenda) return;

    this.savingAgenda.set(true);
    try {
      const res = await fetch(`${this.apiUrl}/admin/event-config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({
          config: {
            open_after_publish_hours: Number(agenda.open_after_publish_hours),
            claims_window_hours: Number(agenda.claims_window_hours),
            closing_window_hours: Number(agenda.closing_window_hours),
            pickup_schedule_info: agenda.pickup_schedule_info?.trim() || null
          }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Error al guardar la agenda.');
      this.toastService.success('Agenda de eventos actualizada.');
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.savingAgenda.set(false);
    }
  }
}
