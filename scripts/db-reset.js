#!/usr/bin/env node
/**
 * scripts/db-reset.js
 *
 * RESET COMPLETO (Estrategia v2, D1) — wipes the configured Neon database and
 * rebuilds the SCHEMA v2 from scratch:
 *   1. DROP SCHEMA public CASCADE; CREATE SCHEMA public;
 *   2. Apply database/init.sql (enums + tablas base: users, events, items,
 *      claims).
 *   3. Apply every migration in database/migrations/*.sql (lexicographic
 *      order: 0001_item_delivery_forensics.sql .. 0004_trust_matrix_and_agenda.sql).
 *
 * El schema legacy quedó archivado como SOLO referencia en
 * database/migrations/_legacy/ y NO se aplica en el reset.
 *
 * Con --seed se PRESERVAN los items capturados de la BD actual (solo las
 * columnas pertinentes para v2: título, descripción, categoría, info_url,
 * image_urls, visibility_level, precio_base_costo) antes del wipe en
 * scripts/.db-preserved-items.json; db-seed los re-inserta bajo el evento de
 * seed. El archivo temporal se elimina al terminar el seed.
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

// Archivo temporal donde se exportan los items capturados (solo las columnas
// pertinentes para v2) ANTES del wipe, para que db-seed los re-inserte bajo el
// evento de seed y no se pierda el trabajo de captura (ver petición del usuario).
const PRESERVE_ITEMS_FILE = path.resolve(process.cwd(), 'scripts', '.db-preserved-items.json');

/**
 * Exporta los items actuales de la BD (legacy o v2) con las columnas pertinentes
 * para el schema v2 a un archivo JSON temporal. No lanza error: si falla, el
 * reset continúa y el seed usará solo sus items demo.
 */
async function exportLegacyItems(file) {
  try {
    const res = await pool.query(
      `SELECT title, description, category::text AS category, info_url,
              image_urls, visibility_level, precio_base_costo
       FROM items
       ORDER BY created_at ASC`
    );
    const rows = res.rows.map((r) => ({
      title: r.title,
      description: r.description,
      category: r.category,
      info_url: r.info_url ?? null,
      image_urls: Array.isArray(r.image_urls) ? r.image_urls : [],
      visibility_level: r.visibility_level,
      precio_base_costo: r.precio_base_costo != null ? Number(r.precio_base_costo) : null
    }));
    fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`[RESET] Preserved ${rows.length} items -> ${file}`);
  } catch (err) {
    console.error('[RESET] WARN: could not export legacy items to preserve:', err.message);
  }
}

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

  // Current state summary (dry run or pre-wipe info). Tablas del SCHEMA v2.
  const tables = [
    'users',
    'events',
    'items',
    'claims',
    'event_members',
    'event_invitations',
    'event_config',
    'trust_levels_settings',
    'admin_sessions',
    'feed_history',
    'audit_log'
  ];
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

  // Preservar items capturados antes del wipe cuando se va a re-seedar.
  if (withSeed) {
    await exportLegacyItems(PRESERVE_ITEMS_FILE);
  }

  console.log('\n[RESET] Wiping schema public...');
  await runSql('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;', 'drop+create schema');

  // init.sql: enums + tablas base (users, events, items, claims) del schema v2
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
