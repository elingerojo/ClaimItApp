import { Component, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';
import { railwayApiUrl } from '../../app.config';
import { AdminAuth } from '../admin-auth/admin-auth';

/** Máx. horas de adelanto en la matriz (0..360 = 15 días, espejo de shared). */
const ADVANCE_HOURS_MAX = 360;
/** Multiplicador de precio por rol (rango que valida el backend/shared). */
const MULTIPLIER_MAX = 9.99;

/**
 * Fila editable de la matriz de confianza v2 (trust_levels_settings).
 * Por rol:
 *  - advancePub  = advance_pub_hours_default  (adelanta la VISIBILIDAD desde published_at)
 *  - advanceDisp = advance_disp_hours_default (adelanta el INICIO DE CLAIM desde available_from)
 *  - multiplier  = multiplicador_precio_default
 *  - maxApartados = max_apartados_simultaneos
 * Invariante por rol (CHECK BD + validador shared): advanceDisp <= advancePub
 * ("nunca se reclama sin ver"). Ya NO existen advance_hours_default,
 * share_bonus_default ni intervalo_recoleccion_horas_default (D8).
 */
export interface RoleRow {
  id: string;
  advancePub: number;
  advanceDisp: number;
  multiplier: number | null;
  maxApartados: number | null;
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

  /** Valores cargados por rol (para mandar al PUT solo las columnas cambiadas). */
  private original = new Map<string, RoleRow>();
  /** Mensaje/flag de la GUARDA 409 de la matriz (eventos publicados o en curso). */
  readonly guardBlocked = signal(false);
  readonly guardMessage = signal<string | null>(null);

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
    this.guardBlocked.set(false);
    this.guardMessage.set(null);
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

      const mapped: RoleRow[] = (rolesData.roles ?? []).map((r: any) => ({
        id: r.id,
        advancePub: r.advance_pub_hours_default != null ? Number(r.advance_pub_hours_default) : 0,
        advanceDisp: r.advance_disp_hours_default != null ? Number(r.advance_disp_hours_default) : 0,
        multiplier:
          r.multiplicador_precio_default != null ? Number(r.multiplicador_precio_default) : null,
        maxApartados:
          r.max_apartados_simultaneos != null ? Number(r.max_apartados_simultaneos) : null
      }));
      this.roles.set(mapped);
      // Snapshot de referencia para detectar cambios campo a campo al guardar.
      this.original = new Map(mapped.map((r) => [r.id, { ...r }]));

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

  /** Invariante v2 por rol: nunca se reclama sin ver (advanceDisp <= advancePub). */
  rowInvalid(row: RoleRow): boolean {
    return row.advanceDisp > row.advancePub;
  }

  /** ¿Algún rol rompe la invariante (bloquea el guardado)? */
  hasInvariantErrors(): boolean {
    return this.roles().some((r) => this.rowInvalid(r));
  }

  /**
   * Guarda la matriz v2 (PUT /api/admin/role-config). Solo envía las columnas
   * que el admin cambió: así editar SOLO precio/apartados se permite aunque
   * haya eventos en curso, mientras que tocar advance_pub/disp dispara la
   * guarda del backend (409) si hay eventos scheduled/active/closing.
   */
  async saveRoles(): Promise<void> {
    if (this.hasInvariantErrors()) {
      const bad = this.roles()
        .filter((r) => this.rowInvalid(r))
        .map((r) => ROLE_LABELS[r.id] ?? r.id)
        .join(', ');
      this.toastService.error(
        `Corrige la invariante antes de guardar (${bad}): el adelanto de apartado (disp) ` +
          'no puede superar al de visibilidad (pub).'
      );
      return;
    }

    const rolesPayload: Record<string, Record<string, number>> = {};
    let changed = false;

    for (const row of this.roles()) {
      const orig = this.original.get(row.id);
      if (!orig) continue;
      const patch: Record<string, number> = {};
      if (row.advancePub !== orig.advancePub) {
        patch['advance_pub_hours_default'] = Number(row.advancePub);
      }
      if (row.advanceDisp !== orig.advanceDisp) {
        patch['advance_disp_hours_default'] = Number(row.advanceDisp);
      }
      if (row.multiplier !== orig.multiplier && row.multiplier != null) {
        patch['multiplicador_precio_default'] = Number(row.multiplier);
      }
      if (row.maxApartados !== orig.maxApartados && row.maxApartados != null) {
        patch['max_apartados_simultaneos'] = Number(row.maxApartados);
      }
      if (Object.keys(patch).length > 0) {
        rolesPayload[row.id] = patch;
        changed = true;
      }
    }

    if (!changed) {
      this.toastService.info('No hay cambios en la matriz de confianza.');
      return;
    }

    // DEBUG: ver qué se está por enviar (tipos exactos por rol/campo).
    for (const [role, patch] of Object.entries(rolesPayload)) {
      console.log(`[role-config][DEBUG] SENDING role=${role}`, patch);
    }

    this.savingRoles.set(true);
    this.guardBlocked.set(false);
    this.guardMessage.set(null);
    try {
      const res = await fetch(`${this.apiUrl}/admin/role-config`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': this.adminTokenService.token()
        },
        body: JSON.stringify({ config: { roles: rolesPayload } })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          // Guarda de la matriz: hay eventos publicados/en curso (scheduled/active/closing).
          this.guardBlocked.set(true);
          this.guardMessage.set(data?.error ?? 'La matriz está bloqueada por eventos en curso.');
        }
        throw new Error(data?.error || 'Error al guardar la matriz de roles.');
      }
      this.toastService.success('Matriz de confianza actualizada.');
      // Refrescar valores normalizados desde el server.
      await this.load();
    } catch (err: any) {
      this.toastService.error(`Error: ${err.message}`);
    } finally {
      this.savingRoles.set(false);
    }
  }

  /** Guarda la plantilla de agenda (event-config se conserva en v2). */
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

  /** Rango máx. de horas de adelanto (para atributos min/max). */
  readonly advanceHoursMax = ADVANCE_HOURS_MAX;
  readonly multiplierMax = MULTIPLIER_MAX;
}
