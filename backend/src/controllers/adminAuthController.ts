/**
 * backend/src/controllers/adminAuthController.ts
 *
 * Autenticación de administrador:
 * - POST /api/admin/login     -> valida el password y emite un token opaco.
 * - GET  /api/admin/session   -> valida el token guardado (arranque de sesión).
 * - POST /api/admin/logout    -> revoca la sesión del dispositivo actual.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { generateToken, createSession, deleteSession } from '../utils/adminSession.js';

const expectedPassword = process.env.ADMIN_TOKEN || '';

/** Comparación de tiempo constante para evitar timing attacks. */
const safeEqual = (a: string, b: string): boolean => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export const adminLogin = async (req: Request, res: Response): Promise<void> => {
  const { password, deviceLabel } = req.body ?? {};

  if (!password || !expectedPassword || !safeEqual(password, expectedPassword)) {
    res.status(401).json({ error: 'Password incorrecto.' });
    return;
  }

  const token = generateToken();
  await createSession(token, deviceLabel || undefined);

  res.status(200).json({ token });
};

export const adminSessionStatus = (_req: Request, res: Response): void => {
  // El middleware requireAdminSession ya validó y renovó la sesión.
  res.status(200).json({ valid: true });
};

export const adminLogout = async (req: Request, res: Response): Promise<void> => {
  const token = req.headers['x-admin-token'] as string;
  await deleteSession(token);
  res.status(200).json({ success: true });
};
