#!/usr/bin/env node
/**
 * scripts/run-migration.js
 *
 * Applies a database migration file to the configured PostgreSQL/Neon DB and
 * prints a verification summary. Reads credentials from `backend/.env`
 * (DATABASE_USERNAME, DATABASE_HOST, DATABASE_NAME, DATABASE_PASSWORD,
 * DATABASE_PORT, DATABASE_SSL) — the same variables used by
 * backend/src/config/db.ts. This is the CLI equivalent of running the SQL in
 * PgAdmin's query editor, but driven from the terminal (Node + pg).
 *
 * Usage (from repo root):
 *   node scripts/run-migration.js database/migrations/005_add_time_automations.sql
 *
 * Migrations are idempotent (IF NOT EXISTS), safe to run multiple times.
 * Secrets are never printed.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

// Load backend/.env relative to the repo root (process.cwd()).
const envPath = path.resolve(process.cwd(), 'backend', '.env');
dotenv.config({ path: envPath });

const pool = new Pool({
  user: process.env.DATABASE_USERNAME,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : 5432,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
});

async function main() {
  const migrationFile = process.argv[2];
  if (!migrationFile) {
    console.error('Usage: node scripts/run-migration.js <path-to-migration.sql>');
    process.exit(1);
  }

  const sqlPath = path.resolve(process.cwd(), migrationFile);
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log(`Applying migration: ${migrationFile}`);

  try {
    // No params -> simple query protocol, so BEGIN/COMMIT and multiple
    // statements inside the file are supported.
    const result = await pool.query(sql);
    console.log(`OK - migration executed (last command: ${result.command}).`);
  } catch (err) {
    console.error('Migration FAILED:', err.message);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  // --- Verification summary ---
  const tables = ['events', 'items', 'claims'];
  console.log('\nVerification - columns per table:');
  const v = await pool.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_name = ANY($1)
     ORDER BY table_name, ordinal_position`,
    [tables]
  );
  const byTable = {};
  for (const row of v.rows) {
    (byTable[row.table_name] = byTable[row.table_name] || []).push(
      `${row.column_name} (${row.data_type})`
    );
  }
  for (const t of tables) {
    console.log(`  ${t}: ${(byTable[t] || []).join(', ')}`);
  }

  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM items WHERE event_id IS NULL');
  console.log(`\nitems without event_id: ${cnt.rows[0].n}`);

  await pool.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
