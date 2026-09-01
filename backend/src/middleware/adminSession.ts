/**
 * backend/src/middleware/adminSession.ts
 *
 * Middleware de autenticación para endpoints administrativos.
 * Valida el token de sesión (header X-Admin-Token) contra la BD con
 * ventana deslizante de 48h. En caso de sesión inválida o expirada
 * responde 401 para que el frontend obligue al admin a re-autenticarse.
 */

import { Request, Response, NextFunction } from 'express';
import { validateSessionToken } from '../utils/adminSession.js';

export const requireAdminSession = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = req.headers['x-admin-token'] as string;
  const session = await validateSessionToken(token);

  if (!session) {
    res.status(401).json({
      error: 'Sesión inválida o expirada. Inicia sesión de nuevo.'
    });
    return;
  }

  (req as any).adminSession = session;
  next();
};
