/**
 * backend/src/controllers/configController.ts
 *
 * Endpoints admin para la configuración global que alimenta la creación de
 * eventos (ver plans/configuracion-plantilla-eventos-ancla-unica.md):
 *
 *  - event-config: plantilla de agenda (event_config id=1) → deriva las 4
 *    fechas públicas desde la fecha de publicación (ancla única) + nota.
 *  - role-config: ventajas por rol editables de la matriz de confianza
 *    (trust_levels_settings): anticipación (advance_hours_default), bonus por
 *    referido (share_bonus_default) y ventana de recogida
 *    (intervalo_recoleccion_horas_default). NO toca precios/apartados.
 *
 * Todos requieren sesión admin (requireAdminSession).
 */
import { Request, Response } from 'express';
import pool from '../config/db.js';
import { validateEventConfig, validateRoleDefaultsUpdate } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { upsertTrustSetting } from '../cache/appStore.js';

const EVENT_CONFIG_ID = 1;
const ROLE_ORDER = ['familiares', 'amigos', 'conocidos', 'publico'] as const;

/** Extract admin code suffix for audit (same pattern as adminController). */
function adminCodeOf(req: Request): string {
  const session = (req as any).adminSession;
  return session?.id != null ? String(session.id) : 'system';
}

/**
 * GET /api/admin/event-config
 * Devuelve la plantilla de agenda global (1 fila).
 */
export const getEventConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query('SELECT * FROM event_config WHERE id = $1', [EVENT_CONFIG_ID]);
    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Configuración de agenda no encontrada. Aplica la migración 012 (event_config).'
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
        error: 'Configuración de agenda no encontrada. Aplica la migración 012 (event_config).'
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
 * Devuelve las filas editables de la matriz de confianza (en orden de rol) +
 * columnas informativas read-only (precio/apartados).
 */
export const getRoleConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id,
              advance_hours_default,
              share_bonus_default,
              intervalo_recoleccion_horas_default,
              multiplicador_precio_default,
              max_apartados_simultaneos
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
 * PUT /api/admin/role-config
 * Actualiza SOLO advance_hours_default / share_bonus_default /
 * intervalo_recoleccion_horas_default por rol (write-through a RAM).
 * Body: { roles: { familiares: { advance_hours_default, share_bonus_default,
 * intervalo_recoleccion_horas_default }, ... } }
 */
export const updateRoleConfig = async (req: Request, res: Response): Promise<void> => {
  const body = req.body?.config ?? req.body; // { roles: {...} }

  const validation = validateRoleDefaultsUpdate(body);
  if (!validation.valid) {
    res.status(400).json({ error: 'Validation failed', details: validation.errors });
    return;
  }

  const roles = body.roles ?? {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const role of ROLE_ORDER) {
      const r = roles[role];
      if (r === undefined || r === null) continue;

      const advance = Number(r.advance_hours_default);
      const bonus = Number(r.share_bonus_default);
      const pickup = Number(r.intervalo_recoleccion_horas_default);

      await client.query(
        `UPDATE trust_levels_settings SET
           advance_hours_default = $2,
           share_bonus_default   = $3,
           intervalo_recoleccion_horas_default = $4
         WHERE id = $1`,
        [role, advance, bonus, pickup]
      );

      // Write-through: reflejar el cambio en el store en RAM (getTrustSetting).
      upsertTrustSetting(role, {
        advance_hours_default: advance,
        share_bonus_default: bonus,
        intervalo_recoleccion_horas_default: pickup
      });
    }

    await client.query('COMMIT');

    const after = await pool.query(
      `SELECT id, advance_hours_default, share_bonus_default,
              intervalo_recoleccion_horas_default
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
