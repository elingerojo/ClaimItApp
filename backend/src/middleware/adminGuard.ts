/**
 * backend/src/middleware/adminGuard.ts
 *
 * Middleware to protect admin endpoints with simple code-based access control.
 * No JWT, no passwords - just a shared admin code configured via .env
 * 
 * Usage:
 *   app.post('/api/admin/items', requireAdminCode, createItem);
 */

import { Request, Response, NextFunction } from 'express';

export const requireAdminCode = (req: Request, res: Response, next: NextFunction): void => {
  const adminCodeHeader = req.headers['x-admin-code'] as string;
  const expectedCode = process.env.ADMIN_CODE || 'admin-default-123';

  if (!adminCodeHeader || adminCodeHeader !== expectedCode) {
    res.status(403).json({
      error: 'Access denied. Admin code required via X-Admin-Code header.',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Log successful admin authentication (last 4 chars masked)
  console.log(`[ADMIN] Authentication successful. Code: ...${adminCodeHeader.slice(-4)}`);

  // Attach admin code to request for auditing
  (req as any).adminCode = adminCodeHeader;

  next();
};
