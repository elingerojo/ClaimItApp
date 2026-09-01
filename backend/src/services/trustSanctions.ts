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
 * the corresponding sanction if the threshold is crossed. Runs inside the
 * caller's transaction (client). Returns null when the user is not a member.
 */
export async function applyExpirationSanction(
  eventId: string,
  userUuid: string,
  client: any
): Promise<SanctionResult | null> {
  const upd = await client.query(
    `UPDATE event_members
     SET expiraciones_acumuladas = expiraciones_acumuladas + 1
     WHERE event_id = $1 AND user_uuid = $2
     RETURNING role, expiraciones_acumuladas`,
    [eventId, userUuid]
  );

  let role: string;
  let expiraciones_acumuladas: number;
  if (upd.rows.length === 0) {
    // Sin membresía: se usa el rol global. Un 'publico' se bloquea desde la
    // primera expiración (umbral 1), aunque no sea miembro del evento.
    const u = await client.query('SELECT global_role FROM users WHERE uuid = $1', [userUuid]);
    role = u.rows[0]?.global_role || 'publico';
    if (role === 'publico') {
      await client.query('UPDATE users SET bloqueado_apartar = true WHERE uuid = $1', [userUuid]);
      return { role, expiraciones: 1, sanctioned: 'blacklisted' };
    }
    return null; // no-miembro y no-publico: sin seguimiento de tolerancia
  }
  role = upd.rows[0].role;
  expiraciones_acumuladas = upd.rows[0].expiraciones_acumuladas;
  const threshold = TOLERANCE_THRESHOLDS[role];
  if (threshold == null) {
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'none' };
  }
  if (expiraciones_acumuladas < threshold) {
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'none' };
  }

  if (role === 'amigos') {
    await client.query(
      `UPDATE event_members SET bloqueado_invitar = true
       WHERE event_id = $1 AND user_uuid = $2`,
      [eventId, userUuid]
    );
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'invite_blocked' };
  }

  if (role === 'conocidos') {
    await client.query(
      `UPDATE event_members SET role = 'publico', bloqueado_invitar = true
       WHERE event_id = $1 AND user_uuid = $2`,
      [eventId, userUuid]
    );
    await client.query(`UPDATE users SET global_role = 'publico' WHERE uuid = $1`, [userUuid]);
    return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'degraded' };
  }

  // publico: blacklist for future separation phases
  await client.query(`UPDATE users SET bloqueado_apartar = true WHERE uuid = $1`, [userUuid]);
  return { role, expiraciones: expiraciones_acumuladas, sanctioned: 'blacklisted' };
}

/**
 * Reduces the accumulated expirations when a user completes a purchase on
 * time and lifts the invite-block sanction if the count drops below the
 * threshold. Runs inside the caller's transaction (client).
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
     RETURNING role, expiraciones_acumuladas`,
    [eventId, userUuid]
  );
  if (upd.rows.length === 0) return;

  const { role, expiraciones_acumuladas } = upd.rows[0];
  const threshold = TOLERANCE_THRESHOLDS[role];
  if (threshold != null && expiraciones_acumuladas < threshold) {
    await client.query(
      `UPDATE event_members SET bloqueado_invitar = false
       WHERE event_id = $1 AND user_uuid = $2`,
      [eventId, userUuid]
    );
  }
}
