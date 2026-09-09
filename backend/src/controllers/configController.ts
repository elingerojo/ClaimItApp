/**
 * backend/src/controllers/configController.ts — Configuración global admin (v2)
 *
 *  - event-config: plantilla de agenda (event_config id=1) → deriva las 4
 *    fechas públicas desde la fecha de publicación (ancla única) + nota.
 *  - role-config: matriz de confianza v2 (trust_levels_settings). Por rol:
 *      * advance_pub_hours_default  → adelanta la VISIBILIDAD desde published_at
 *      * advance_disp_hours_default → adelanta el INICIO DE CLAIM desde available_from
 *      * multiplicador_precio_default, max_apartados_simultaneos (read/write)
 *    Regla "nunca se reclama sin ver": advance_disp <= advance_pub (CHECK BD +
 *    validador shared).
 *
 * GUARDA DE LA MATRIZ (regla concreta implementada): los cambios de
 * advance_pub/disp_hours_default SOLO aplican a eventos futuros/no iniciados.
 * Como la matriz es global (sin columna por evento), se RECHAZA la edición de
 * esos dos valores mientras exista algún evento con status IN
 * ('scheduled','active','closing') — es decir, un evento ya publicado o en
 * curso cuyo calendario/visibilidad quedó expuesto con la matriz actual. Una vez
 * que todos los eventos terminan (closed) o siguen en draft, la matriz es
 * editable para los próximos eventos. Editar SOLO precio/apartados (que no
 * afectan ventanas temporales) está permitido siempre.
 */

import { Request, Response } from 'express';
import pool from '../config/db.js';
import { validateEventConfig, validateRoleDefaultsUpdate } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { upsertTrustSetting } from '../cache/appStore.js';

const EVENT_CONFIG_ID = 1;
const ROLE_ORDER = ['familiares', 'amigos', 'conocidos', 'publico'] as const;

/** Extract admin code suffix for audit. */
function adminCodeOf(req: Request): string {
  const session = (req as any).adminSession;
  return session?.id != null ? String(session.id) : 'system';
}

/**
 * Guarda de la matriz: true si existe un evento cuyo ciclo temporal ya quedó
 * fijado con la matriz actual (publicado o en curso), lo que bloquea la edición
 * de advance_pub/disp_hours_default.
 */
export async function matrixAdvanceLockedByLiveEvents(): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM events WHERE status IN ('scheduled','active','closing') LIMIT 1`
  );
  return res.rows.length > 0;
}

/**
 * GET /api/admin/event-config
 * Plantilla de agenda global (1 fila).
 */
export const getEventConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM event_config WHERE id = $1', [EVENT_CONFIG_ID]);
    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Configuración de agenda no encontrada. Aplica la migración 0004 (event_config).'
      });
      return;
    }
    res.json({ config: result.rows[0] });
  } catch (error) {
    console.error('Failed to fetch event-config:', error);
    res.status(500).json({ error: 'Failed to fetch event-config' });
  }
};

/**
 * PUT /api/admin/event-config
 * Actualiza la plantilla de agenda. Body plano o { config: {...} }.
 */
export const updateEventConfig = async (req: Request, res: Response): Promise<void> => {
  const body = req.body?.config ?? req.body;

  const validation = validateEventConfig(body);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', details: validation.errors });
    return;
  }

  try {
    const upd = await pool.query(
      `UPDATE event_config SET
         open_after_publish_hours = $2,
         claims_window_hours      = $3,
         closing_window_hours     = $4,
         pickup_schedule_info     = $5,
         updated_at               = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        EVENT_CONFIG_ID,
        Number(body.open_after_publish_hours),
        Number(body.claims_window_hours),
        Number(body.closing_window_hours),
        body.pickup_schedule_info ?? null
      ]
    );
    if (upd.rows.length === 0) {
      res.status(404).json({
        error: 'Configuración de agenda no encontrada. Aplica la migración 0004 (event_config).'
      });
      return;
    }

    await logAudit({
      action: 'EVENT_CONFIG_UPDATED',
      adminCodeSuffix: maskAdminCode(adminCodeOf(req)),
      details: {
        open_after_publish_hours: Number(body.open_after_publish_hours),
        claims_window_hours: Number(body.claims_window_hours),
        closing_window_hours: Number(body.closing_window_hours),
        timestamp: new Date().toISOString()
      }
    });

    res.json({ success: true, config: upd.rows[0] });
  } catch (error) {
    console.error('Failed to update event-config:', error);
    res.status(500).json({ error: 'Failed to update event-config' });
  }
};

/**
 * GET /api/admin/role-config
 * Devuelve las filas de la matriz de confianza v2 en orden de rol.
 */
export const getRoleConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id,
              advance_pub_hours_default,
              advance_disp_hours_default,
              multiplicador_precio_default,
              max_apartados_simultaneos,
              updated_at
       FROM trust_levels_settings
       ORDER BY array_position(ARRAY['familiares','amigos','conocidos','publico'], id)`
    );
    res.json({ roles: result.rows });
  } catch (error) {
    console.error('Failed to fetch role-config:', error);
    res.status(500).json({ error: 'Failed to fetch role-config' });
  }
};

/**
 * PUT /api/admin/role-config — actualiza la matriz v2 por rol.
 * Body: { roles: { familiares: { advance_pub_hours_default?,
 * advance_disp_hours_default?, multiplicador_precio_default?,
 * max_apartados_simultaneos? }, ... } }
 *
 * Valida (advance_disp <= advance_pub, rangos) y aplica la GUARDA de la matriz
 * cuando el payload edita advance_pub/disp con eventos live.
 */
export const updateRoleConfig = async (req: Request, res: Response): Promise<void> => {
  const body = req.body?.config ?? req.body; // { roles: {...} }

  const validation = validateRoleDefaultsUpdate(body);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', details: validation.errors });
    return;
  }

  const roles = body.roles ?? {};

  // ¿El payload toca los adelantos temporales? (los que disparan la guarda).
  const touchesAdvance = ROLE_ORDER.some((role) => {
    const r = roles[role];
    return (
      r &&
      (r.advance_pub_hours_default !== undefined || r.advance_disp_hours_default !== undefined)
    );
  });

  const client = await pool.connect();
  try {
    if (touchesAdvance) {
      const locked = await matrixAdvanceLockedByLiveEvents();
      if (locked) {
        res.status(409).json({
          error:
            'La matriz de adelantos (advance_pub/disp) no se puede editar mientras exista un ' +
            'evento publicado o en curso (status scheduled/active/closing): los cambios solo ' +
            'aplican a eventos futuros/no iniciados. Edita solo precio o apartados, o espera a ' +
            'que los eventos cierren.'
        });
        return;
      }
    }

    await client.query('BEGIN');

    for (const role of ROLE_ORDER) {
      const r = roles[role];
      if (r === undefined || r === null) continue;

      const assignments: string[] = [];
      const params: any[] = [];
      const set = (column: string, value: any): void => {
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      };
      if (r.advance_pub_hours_default !== undefined) set('advance_pub_hours_default', Number(r.advance_pub_hours_default));
      if (r.advance_disp_hours_default !== undefined) set('advance_disp_hours_default', Number(r.advance_disp_hours_default));
      if (r.multiplicador_precio_default !== undefined) set('multiplicador_precio_default', Number(r.multiplicador_precio_default));
      if (r.max_apartados_simultaneos !== undefined) set('max_apartados_simultaneos', Number(r.max_apartados_simultaneos));
      if (assignments.length === 0) continue;

      params.push(role);
      await client.query(
        `UPDATE trust_levels_settings SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}`,
        params
      );

      // Write-through a RAM (getTrustSetting → pricing/feed).
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (r.advance_pub_hours_default !== undefined) patch.advance_pub_hours_default = Number(r.advance_pub_hours_default);
      if (r.advance_disp_hours_default !== undefined) patch.advance_disp_hours_default = Number(r.advance_disp_hours_default);
      if (r.multiplicador_precio_default !== undefined) patch.multiplicador_precio_default = Number(r.multiplicador_precio_default);
      if (r.max_apartados_simultaneos !== undefined) patch.max_apartados_simultaneos = Number(r.max_apartados_simultaneos);
      upsertTrustSetting(role, patch);
    }

    await client.query('COMMIT');

    const after = await pool.query(
      `SELECT id, advance_pub_hours_default, advance_disp_hours_default,
              multiplicador_precio_default, max_apartados_simultaneos, updated_at
       FROM trust_levels_settings
       ORDER BY array_position(ARRAY['familiares','amigos','conocidos','publico'], id)`
    );

    await logAudit({
      action: 'ROLE_CONFIG_UPDATED',
      adminCodeSuffix: maskAdminCode(adminCodeOf(req)),
      details: {
        roles: after.rows,
        timestamp: new Date().toISOString()
      }
    });

    res.json({ success: true, roles: after.rows });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to update role-config:', error);
    res.status(500).json({ error: 'Failed to update role-config' });
  } finally {
    client.release();
  }
};
