#!/usr/bin/env node
/**
 * scripts/db-snapshot.js
 *
 * Etapa 1 (reset+seed) helper — READ-ONLY snapshot of the real Neon database.
 * Dumps items, events, event memberships, users and invitation codes to a JSON
 * file so the reset/seed script can (a) copy 5 real items as seed and
 * (b) produce the orphan-blob list without touching production data.
 *
 * Usage (from repo root):
 *   node scripts/db-snapshot.js [output.json]
 * Default output: database/.db-snapshot.json
 *
 * Reads credentials from backend/.env (same vars as db.ts / run-migration.js).
 * Never writes to the database.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(process.cwd(), 'backend', '.env') });

const pool = new Pool({
  user: process.env.DATABASE_USERNAME,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : 5432,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000
});

async function main() {
  const outFile = process.argv[2] || path.join('database', '.db-snapshot.json');

  const [items, events, users, members, invitations, claims, trust] = await Promise.all([
    pool.query('SELECT * FROM items ORDER BY created_at DESC'),
    pool.query('SELECT * FROM events ORDER BY created_at DESC'),
    pool.query('SELECT * FROM users ORDER BY created_at'),
    pool.query('SELECT * FROM event_members ORDER BY joined_at'),
    pool.query('SELECT * FROM event_invitations ORDER BY role'),
    // NOTE: role_at_assignment/pickup_window_hours only exist after migration
    // 008. The reset recreates the schema from scratch, so the snapshot keeps
    // the base claim columns for reference only.
    pool.query(
      `SELECT c.item_id, c.user_uuid, u.alias AS username, c.claimed_at,
              c.pickup_deadline, COALESCE(c.picked_up, false) AS picked_up
       FROM claims c JOIN users u ON c.user_uuid = u.uuid
       ORDER BY c.claimed_at`
    ),
    pool.query('SELECT * FROM trust_levels_settings ORDER BY id')
  ]);

  const snapshot = {
    takenAt: new Date().toISOString(),
    items: items.rows,
    events: events.rows,
    users: users.rows,
    eventMembers: members.rows,
    invitations: invitations.rows,
    claims: claims.rows,
    trustSettings: trust.rows
  };

  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf8');

  // image_urls es un arreglo JSONB por item; se aplana para el conteo.
  const allImageUrls = items.rows.flatMap((r) =>
    Array.isArray(r.image_urls) ? r.image_urls : []
  ).filter(Boolean);
  console.log(`[SNAPSHOT] Wrote ${outFile}`);
  console.log(`[SNAPSHOT] items=${items.rows.length}, events=${events.rows.length}, users=${users.rows.length}`);
  console.log(`[SNAPSHOT] memberships=${members.rows.length}, invitations=${invitations.rows.length}, claims=${claims.rows.length}`);
  console.log(`[SNAPSHOT] distinct image_urls=${new Set(allImageUrls).size}`);

  await pool.end();
}

main().catch((err) => {
  console.error('[SNAPSHOT] Failed:', err.message);
  process.exit(1);
});
