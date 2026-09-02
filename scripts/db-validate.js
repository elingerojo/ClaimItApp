#!/usr/bin/env node
/**
 * scripts/db-validate.js
 *
 * Etapa 1 — verifies the freshly seeded Neon database:
 *   - no items without an event
 *   - the seed event exists with per-role pickup hours and lifecycle fields
 *   - 5 seed items, users and memberships present
 *   - schema has the new columns (events.pickup hours, claims F1 fields)
 *
 * Usage: node scripts/db-validate.js
 */
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
  const orphanItems = await pool.query('SELECT COUNT(*)::int AS n FROM items WHERE event_id IS NULL');
  console.log(`items without event: ${orphanItems.rows[0].n} (expected 0)`);

  const events = await pool.query(
    `SELECT id, title, status, available_from, claims_close_at, pickup_deadline,
            familiares_pickup_hours, amigos_pickup_hours, conocidos_pickup_hours, publico_pickup_hours
     FROM events`
  );
  console.log(`events: ${events.rows.length}`);
  for (const e of events.rows) {
    console.log(`  ${e.title} | status=${e.status}`);
    console.log(`    available_from=${e.available_from} claims_close_at=${e.claims_close_at} pickup_deadline=${e.pickup_deadline}`);
    console.log(`    pickup_hours fam=${e.familiares_pickup_hours} ami=${e.amigos_pickup_hours} con=${e.conocidos_pickup_hours} pub=${e.publico_pickup_hours}`);
  }

  const items = await pool.query(
    `SELECT i.title, i.category, i.visibility_level, i.event_id IS NOT NULL AS has_event,
            i.precio_familiar, i.precio_publico
     FROM items i ORDER BY i.created_at`
  );
  console.log(`items: ${items.rows.length}`);
  for (const i of items.rows) {
    console.log(`  ${i.title} | ${i.category} | vis=${i.visibility_level} | in_event=${i.has_event} | precioFam=${i.precio_familiar} precioPub=${i.precio_publico}`);
  }

  const members = await pool.query(
    `SELECT u.alias, em.role FROM event_members em JOIN users u ON em.user_uuid = u.uuid ORDER BY em.role`
  );
  console.log(`members: ${members.rows.length}`);
  for (const m of members.rows) console.log(`  ${m.role}: ${m.alias}`);

  // Schema sanity: F1 columns + new event columns exist
  const claimsCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'claims' AND column_name IN ('role_at_assignment','pickup_window_hours')`
  );
  console.log(`claims F1 columns present: ${claimsCols.rows.map((c) => c.column_name).join(', ')}`);

  await pool.end();
}

main().catch((err) => {
  console.error('[VALIDATE] Failed:', err.message);
  process.exit(1);
});
