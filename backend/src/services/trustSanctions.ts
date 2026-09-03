/**
 * backend/src/services/trustSanctions.ts
 *
 * Expiration tolerance (checkpoint-matriz-niveles-confianza-ok.md, §3D):
 * counts how many times a user lets their turn (position 1) expire without
 * completing the transaction, and applies per-role sanctions when the
 * threshold is crossed:
 *
 *   familiares: infinite tolerance (no sanction).
 *   amigos:     temporarily lose invitation rights.
 *   conocidos:  permanent automatic degradation to 'publico'.
 *   publico:    account blacklist (blocked from future separation phases).
 *
 * Completing a purchase on time REDUCES the counter and can lift the
 * invite-block sanction.
 */

export const TOLERANCE_THRESHOLDS: Record<string, number | null> = {
  familiares: null, // infinite tolerance
  amigos: 3,
  conocidos: 2,
  publico: 1
};

export type SanctionKind = 'invite_blocked' | 'degraded' | 'blacklisted' | 'none';

export interface SanctionResult {
  role: string;
  expiraciones: number;
  sanctioned: SanctionKind;
}

/**
 * Increments the accumulated expirations of a member in an event and applies
 * the corresponding sanction when the threshold is crossed. Fase 2: el rol es
 * GLOBAL (única fuente de verdad), así que la tolerancia/degradación aplica
 * contra users.global_role; la membresía conserva solo su contador por evento
 * (expiraciones_acumuladas) y el bloqueo de invitar por evento. Corre dentro
 * de la transacción del llamador (client).
 */
export async function applyExpirationSanction(
  eventId: string,
  userUuid: string,
  client: any
): Promise<SanctionResult | null> {
  // Rol único = rol global del usuario.
  const u = await client.query('SELECT global_role FROM users WHERE uuid = $1', [userUuid]);
  const role = u.rows[0]?.global_role || 'publico';

  // Incrementar el contador de expiraciones del miembro en el evento (si lo es).
  const upd = await client.query(
    `UPDATE event_members
     SET expiraciones_acumuladas = expiraciones_acumuladas + 1
     WHERE event_id = $1 AND user_uuid = $2
     RETURNING expiraciones_acumuladas`,
    [eventId, userUuid]
  );
  const expiraciones_acumuladas =
    upd.rows.length > 0 ? upd.rows[0].expiraciones_acumuladas : 1;

  const threshold = TOLERANCE_THRESHOLDS[role];
  if (threshold == null) {
    // familiares: tolerancia infinita.
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'none' };
  }
  if (expiraciones_acumuladas < threshold) {
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'none' };
  }

  if (role === 'amigos') {
    // Pierde temporalmente el derecho a invitar (por evento).
    await client.query(
      `UPDATE event_members SET bloqueado_invitar = true
       WHERE event_id = $1 AND user_uuid = $2`,
      [eventId, userUuid]
    );
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'invite_blocked' };
  }

  if (role === 'conocidos') {
    // Degradación global permanente a publico + bloqueo de invitar en el evento.
    await client.query(
      `UPDATE event_members SET bloqueado_invitar = true
       WHERE event_id = $1 AND user_uuid = $2`,
      [eventId, userUuid]
    );
    await client.query(`UPDATE users SET global_role = 'publico' WHERE uuid = $1`, [userUuid]);
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'degraded' };
  }

  // publico: blacklist global para futuras fases de separación.
  await client.query(`UPDATE users SET bloqueado_apartar = true WHERE uuid = $1`, [userUuid]);
  return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'blacklisted' };
}

/**
 * Reduces the accumulated expirations when a user completes a purchase on
 * time and lifts the invite-block sanction if the count drops below the
 * threshold (evaluated against the user's GLOBAL role). Runs inside the
 * caller's transaction (client).
 */
export async function reduceExpirationCount(
  eventId: string,
  userUuid: string,
  client: any
): Promise<void> {
  const upd = await client.query(
    `UPDATE event_members
     SET expiraciones_acumuladas = GREATEST(expiraciones_acumuladas - 1, 0)
     WHERE event_id = $1 AND user_uuid = $2
     RETURNING expiraciones_acumuladas`,
    [eventId, userUuid]
  );
  if (upd.rows.length === 0) return;

  const expiraciones_acumuladas = upd.rows[0].expiraciones_acumuladas;
  const u = await client.query('SELECT global_role FROM users WHERE uuid = $1', [userUuid]);
  const role = u.rows[0]?.global_role || 'publico';
  const threshold = TOLERANCE_THRESHOLDS[role];
  if (threshold != null && expiraciones_acumuladas < threshold) {
    await client.query(
      `UPDATE event_members SET bloqueado_invitar = false
       WHERE event_id = $1 AND user_uuid = $2`,
      [eventId, userUuid]
    );
  }
}
