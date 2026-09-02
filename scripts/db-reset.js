#!/usr/bin/env node
/**
 * scripts/db-reset.js
 *
 * Etapa 1 — wipes the configured Neon database and rebuilds the schema from
 * scratch:
 *   1. DROP SCHEMA public CASCADE; CREATE SCHEMA public;
 *   2. Apply database/init.sql (base items/claims + enums).
 *   3. Apply every migration in database/migrations/*.sql (lexicographic
 *      order: 0001_create_admin_sessions.sql .. 009_add_feed_history.sql).
 *
 * DESTRUCTIVE: all data is erased. Do NOT run against a DB with data you need.
 * Requires the backend to be STOPPED first (the RAM store write-through would
 * otherwise re-insert stale rows after the wipe).
 *
 * Reads credentials from backend/.env.
 *
 * Usage: node scripts/db-reset.js            (dry-run summary)
 *        node scripts/db-reset.js --yes      (actually wipe + rebuild)
 *        node scripts/db-reset.js --yes --seed  (then run the seed)
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

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'database', 'migrations');
const INIT_SQL = path.resolve(process.cwd(), 'database', 'init.sql');

async function runSql(sql, label) {
  try {
    const result = await pool.query(sql);
    console.log(`  OK ${label} (${result.command || 'multi'})`);
  } catch (err) {
    console.error(`  FAILED ${label}:`, err.message);
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const withSeed = args.includes('--seed');

  // Current state summary (dry run or pre-wipe info)
  const tables = ['items', 'claims', 'users', 'events', 'event_members', 'trust_levels_settings', 'feed_history'];
  const cols = await pool.query(
    `SELECT table_name, COUNT(*)::int AS n
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)
     GROUP BY table_name ORDER BY table_name`,
    [tables]
  );
  console.log('[RESET] Current public tables:');
  for (const t of tables) {
    const found = cols.rows.find((r) => r.table_name === t);
    console.log(`  ${t}: ${found ? 'exists' : 'MISSING'}`);
  }

  if (!confirmed) {
    console.log('\n[RESET] DRY-RUN: add --yes to actually wipe and rebuild.');
    await pool.end();
    return;
  }

  console.log('\n[RESET] Wiping schema public...');
  await runSql('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;', 'drop+create schema');

  // init.sql: base items/claims tables + item_category / item_status enums
  const init = fs.readFileSync(INIT_SQL, 'utf8');
  await runSql(init, 'init.sql (base schema)');

  // Migrations in lexicographic order
  const migrations = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  console.log(`\n[RESET] Applying ${migrations.length} migrations...`);
  for (const file of migrations) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await runSql(sql, file);
  }

  console.log('\n[RESET] Schema rebuilt.');

  const after = await pool.query(
    `SELECT table_name, COUNT(*)::int AS n
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)
     GROUP BY table_name ORDER BY table_name`,
    [tables]
  );
  console.log('[RESET] Tables present after rebuild:');
  for (const t of tables) {
    const found = after.rows.find((r) => r.table_name === t);
    console.log(`  ${t}: ${found ? 'OK' : 'MISSING'}`);
  }

  await pool.end();

  if (withSeed) {
    console.log('\n[RESET] Running seed...');
    require('./db-seed.js');
  } else {
    console.log('\n[RESET] Next step: node scripts/db-seed.js');
  }
}

main().catch((err) => {
  console.error('[RESET] Fatal:', err.message);
  process.exit(1);
});
