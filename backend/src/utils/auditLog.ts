/**
 * backend/src/utils/auditLog.ts
 *
 * Utility functions for logging admin actions to database.
 * Non-blocking: failures in auditing don't affect main operations.
 */

import pool from '../config/db.js';
import type { PoolClient } from 'pg';

export interface AuditEntry {
  action: string;
  adminCodeSuffix: string;
  itemId?: string;
  userId?: string;
  details?: Record<string, any>;
}

/**
 * Log an admin action to the audit_log table.
 * - Without a client: runs standalone via the pool; failures are logged but do
 *   not throw (non-blocking audit for main operations).
 * - With a client: runs inside a caller-managed transaction and returns false on
 *   failure so the caller can recover via SAVEPOINT without aborting the tx.
 * @returns true when the audit row was inserted, false otherwise.
 */
export async function logAudit(entry: AuditEntry, client?: PoolClient): Promise<boolean> {
  try {
    const db = client ?? pool;
    await db.query(
      `INSERT INTO audit_log (action, admin_code_suffix, item_id, user_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        entry.action,
        entry.adminCodeSuffix || 'N/A',
        entry.itemId || null,
        entry.userId || null,
        JSON.stringify(entry.details || {})
      ]
    );

    console.log(
      `[AUDIT] ${entry.action} | Admin: ...${entry.adminCodeSuffix} | ` +
      `Item: ${entry.itemId || 'N/A'} | User: ${entry.userId || 'N/A'}`
    );
    return true;
  } catch (error) {
    console.error('[AUDIT] Failed to log action:', error);
    // Don't throw - auditing failure should not break main operations
    return false;
  }
}

/**
 * Retrieve audit logs (limit: default 100, max 1000)
 */
export async function getAuditLog(limit: number = 100): Promise<AuditEntry[]> {
  try {
    const safeLimitLimit = Math.min(Math.max(limit, 1), 1000);

    const result = await pool.query(
      `SELECT action, admin_code_suffix, item_id, user_id, details, created_at 
       FROM audit_log 
       ORDER BY created_at DESC 
       LIMIT $1`,
      [safeLimitLimit]
    );

    return result.rows;
  } catch (error) {
    console.error('[AUDIT] Failed to fetch log:', error);
    return [];
  }
}

/**
 * Extract admin code suffix from full code
 * Returns last 4 characters for masked logging
 */
export function maskAdminCode(code: string): string {
  if (!code || code.length < 4) return '****';
  return code.slice(-4);
}
