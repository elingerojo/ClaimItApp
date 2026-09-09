#!/usr/bin/env node
/**
 * scripts/db-verify-v2.js
 *
 * Verificación read-only del SCHEMA v2 recién reconstruido por
 * `node scripts/db-reset.js --yes --seed`:
 *   - Columnas reales de las tablas núcleo (events/items/claims/users/...).
 *   - Enums registrados y sus labels.
 *   - Ausencia de columnas legacy (pickup/share/advance) en `events`.
 *   - Evento de seed con contenedor futuro y status activo.
 *   - Items preservados: distribución por phase/status y sanidad de
 *     título/imágenes.
 *
 * Usage: node scripts/db-verify-v2.js
 */
const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

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

async function columnsOf(table) {
  const res = await pool.query(
    `SELECT column_name || ':' || data_type AS c
     FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r) => r.c).join(', ');
}

async function main() {
  console.log('[VERIFY] events       :', await columnsOf('events'));
  console.log('[VERIFY] items        :', await columnsOf('items'));
  console.log('[VERIFY] claims       :', await columnsOf('claims'));
  console.log('[VERIFY] users        :', await columnsOf('users'));
  console.log('[VERIFY] trust_matrix :', await columnsOf('trust_levels_settings'));
  console.log('[VERIFY] event_members:', await columnsOf('event_members'));

  const enums = await pool.query(
    `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
     FROM pg_type t
     JOIN pg_enum e ON e.enumtypid = t.oid
     GROUP BY t.typname
     ORDER BY t.typname`
  );
  console.log('[VERIFY] enums        :', enums.rows.map((r) => `${r.typname}=[${r.labels}]`).join(' | '));

  const legacy = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'events'
       AND (column_name LIKE '%pickup%' OR column_name LIKE '%share%' OR column_name LIKE '%advance%')`
  );
  console.log('[VERIFY] events legacy leftovers:', legacy.rows.length ? legacy.rows.map((r) => r.column_name).join(',') : 'NONE');

  const ev = await pool.query(
    `SELECT title, status,
            to_char(published_at, 'YYYY-MM-DD HH24:MI')  AS p,
            to_char(available_from, 'MM-DD HH24:MI')     AS a,
            to_char(claims_close_at, 'MM-DD HH24:MI')    AS cc,
            to_char(pickup_deadline, 'MM-DD HH24:MI')    AS pd
     FROM events`
  );
  console.log('[VERIFY] event        :', JSON.stringify(ev.rows[0]));

  const it = await pool.query(
    `SELECT phase, status, visibility_level, count(*) AS n
     FROM items
     GROUP BY 1, 2, 3
     ORDER BY n DESC
     LIMIT 5`
  );
  console.log('[VERIFY] items by phase/status:', JSON.stringify(it.rows));

  const imgs = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE jsonb_array_length(image_urls) >= 1)::int AS with_img,
            count(*) FILTER (WHERE title IS NOT NULL AND title <> '')::int  AS with_title,
            count(*) FILTER (WHERE image_urls = '[]'::jsonb)::int AS empty_img
     FROM items`
  );
  console.log('[VERIFY] img/title sanity:', JSON.stringify(imgs.rows[0]));
}

main()
  .catch((err) => {
    console.error('[VERIFY] ERR', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
