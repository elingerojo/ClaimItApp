/**
 * backend/src/utils/adminSession.ts
 *
 * Gestión de sesiones de administrador con tokens opacos (sin dependencias).
 * El token en claro vive solo en el dispositivo (localStorage) y en la petición;
 * en la BD solo se almacena su SHA-256.
 *
 * Ventana deslizante: una sesión expira si no se usa durante 48 horas.
 * Cada uso válido renueva last_used_at (el reloj se reinicia).
 * Multi-dispositivo: cada login crea su propia fila en admin_sessions.
 */

import crypto from 'crypto';
import pool from '../config/db.js';

export const SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 48 horas

export interface AdminSession {
  id: number;
  tokenHash: string;
  createdAt: Date;
  lastUsedAt: Date;
  deviceLabel: string | null;
}

export const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const generateToken = (): string => crypto.randomBytes(32).toString('hex');

export const createSession = async (token: string, deviceLabel?: string): Promise<void> => {
  await pool.query(
    `INSERT INTO admin_sessions (token_hash, device_label) VALUES ($1, $2)`,
    [sha256(token), deviceLabel ?? null]
  );
};

/**
 * Valida un token contra la BD aplicando la ventana deslizante de 48h.
 * - Token inexistente -> null.
 * - Token con más de 48h sin uso -> se elimina y devuelve null (expirada).
 * - Token válido -> renueva last_used_at y devuelve la sesión.
 */
export const validateSessionToken = async (token: string): Promise<AdminSession | null> => {
  if (!token) return null;

  const tokenHash = sha256(token);
  const result = await pool.query(
    `SELECT id, token_hash, created_at, last_used_at, device_label
     FROM admin_sessions WHERE token_hash = $1`,
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) return null;

  const lastUsedAt = new Date(row.last_used_at);
  const now = new Date();

  if (now.getTime() - lastUsedAt.getTime() > SESSION_TTL_MS) {
    await pool.query(`DELETE FROM admin_sessions WHERE id = $1`, [row.id]);
    return null;
  }

  // Ventana deslizante: renovar last_used_at
  await pool.query(`UPDATE admin_sessions SET last_used_at = NOW() WHERE id = $1`, [row.id]);

  return {
    id: row.id,
    tokenHash: row.token_hash,
    createdAt: new Date(row.created_at),
    lastUsedAt,
    deviceLabel: row.device_label ?? null,
  };
};

export const deleteSession = async (token: string): Promise<void> => {
  if (!token) return;
  await pool.query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [sha256(token)]);
};

/** Elimina todas las sesiones con más de 48h de inactividad. */
export const deleteExpiredSessions = async (): Promise<void> => {
  await pool.query(`DELETE FROM admin_sessions WHERE NOW() - last_used_at > interval '48 hours'`);
};
