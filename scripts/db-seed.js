#!/usr/bin/env node
/**
 * scripts/db-seed.js
 *
 * RESET COMPLETO (Estrategia v2, D1) — seeds the freshly rebuilt SCHEMA v2 with:
 *   - Matriz de confianza por rol (advance_pub/disp_hours_default + precio por
 *     rol + límite de apartados) y plantilla de agenda (event_config id=1).
 *   - Demo users per role (familiares / amigos / conocidos / publico).
 *   - UN evento de contenedor FUTURO para poder probar la fase de reclamo y
 *     luego el motor de recolección: published_at y available_from en el pasado
 *     (evento visible y con "Lo quiero" abierto) y claims_close_at /
 *     pickup_deadline en el futuro (T_inicio..T_final por delante).
 *   - Membresías por evento SIN rol y SIN bonus_hours (familiares/amigos/
 *     conocidos se unen; el usuario publico NO es miembro para probar el
 *     fallback de rol global) + 4 códigos de invitación (uno por rol).
 *   - Items: si scripts/.db-preserved-items.json existe (lo genera db-reset.js
 *     --yes --seed ANTES del wipe) se re-insertan los items capturados (122)
 *     bajo el evento de seed con las columnas pertinentes de v2 (phase
 *     'claim_open', status 'available'). Si no existe el archivo, se siembran 5
 *     items demo reales que REUTILIZAN su image_url de Vercel Blob (no huérfana).
 *
 * Debe correr DESPUÉS del rebuild desde cero (init.sql + migraciones 0001-0004).
 * Lee credenciales de backend/.env. Idempotente-ish (ON CONFLICT en la matriz,
 * config y usuarios; salto si ya existe un evento).
 *
 * Usage: node scripts/db-seed.js
 *        node scripts/db-reset.js --yes --seed
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

// Archivo temporal con los items capturados que db-reset.js exportó antes del wipe.
const PRESERVE_ITEMS_FILE = path.resolve(process.cwd(), 'scripts', '.db-preserved-items.json');

/** Categorías válidas del enum item_category (schema v2). */
const ITEM_CATEGORIES = [
  'Kitchen', 'Electronics', 'Decor', 'Books', 'Media', 'Clothing', 'Bedding',
  'Shoes', 'Accessories', 'Bathroom', 'Office', 'Utilities', 'Cleaning',
  'Sports', 'Misc.'
];

/** Normaliza la categoría a un valor del enum (desconocida -> 'Misc.'). */
function normalizeCategory(cat) {
  return ITEM_CATEGORIES.includes(cat) ? cat : 'Misc.';
}

/** Lee el archivo de preservación si existe. Devuelve [] si no hay. */
function loadPreservedItems() {
  if (!fs.existsSync(PRESERVE_ITEMS_FILE)) return [];
  try {
    const raw = fs.readFileSync(PRESERVE_ITEMS_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('[SEED] WARN: could not parse preserved items file:', err.message);
    return [];
  }
}

/** Convierte una fila exportada de la BD a la forma de item que siembra el seed. */
function normalizePreservedRow(r) {
  const imageUrls = Array.isArray(r.image_urls) ? r.image_urls.filter((u) => typeof u === 'string' && u) : [];
  const vis = Number.isInteger(r.visibility_level) ? r.visibility_level : 4;
  return {
    title: r.title,
    description: r.description ?? null,
    category: normalizeCategory(r.category),
    infoUrl: r.info_url || null,
    imageUrls,
    visibilityLevel: vis >= 0 && vis <= 4 ? vis : 4,
    baseCost: r.precio_base_costo != null ? Number(r.precio_base_costo) : null
  };
}

// 5 real demo items: text/category copied from the previous DB, image_url REUSED
// (solo se usan cuando NO hay items preservados).
const DEMO_ITEMS = [
  {
    title: 'Audífonos Skullcandy Jib True Wireless',
    description:
      'Audífonos inalámbricos de color negro en buen estado, incluyen su estuche de carga original.',
    category: 'Electronics',
    infoUrl: 'https://www.google.com.mx/search?q=audifonos+skullcandy+jib+true+wireless',
    imageUrls: [
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17863973008953426777157718031845-cRm36rFqHftCj1z7AwSTqMeBwrOjk5.jpg'
    ],
    visibilityLevel: 4,
    baseCost: 300
  },
  {
    title: 'Jarrón de vidrio transparente',
    description:
      'Un jarrón clásico de vidrio transparente en excelentes condiciones, ideal para arreglos florales.',
    category: 'Decor',
    infoUrl: 'https://www.google.com/search?q=jarrón+de+vidrio+transparente',
    imageUrls: [
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840607625171452375709992991267-CMFJWE7IcdOjGYAALLdDZAH9188wus.jpg'
    ],
    visibilityLevel: 2,
    baseCost: 80
  },
  {
    title: 'Crema de Avellana con Cacao Keto Morama',
    description:
      'Tarro de crema de avellana con cacao tipo keto de la marca Morama. Producto sellado y en perfectas condiciones.',
    category: 'Kitchen',
    infoUrl: 'https://morama.com.mx/products/crema-de-avellana-con-cacao-keto',
    imageUrls: [
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840782177727144257448346994374-I4ngwjcLFqmyGsuxWernpXNCXnPVyU.jpg'
    ],
    visibilityLevel: 3,
    baseCost: 90
  },
  {
    title: 'La Revolución de la Glucosa',
    description:
      'Libro de salud y nutrición de Jessie Inchauspé que explica cómo equilibrar los niveles de glucosa. Ejemplar en buen estado con marcas de lectura.',
    category: 'Books',
    infoUrl: 'https://www.goodreads.com/book/show/60447385-la-revoluci-n-de-la-glucosa',
    imageUrls: [
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840225319433966550507975701491-f27c4hv1OfqdSeR1IOKcYarSTGbGGd.jpg'
    ],
    visibilityLevel: 4,
    baseCost: 120
  },
  {
    title: 'Cinta adhesiva de embalaje Frágil',
    description:
      "Rollo de cinta adhesiva marca Overtape con la leyenda 'Frágil', ideal para asegurar paquetes delicados durante una mudanza.",
    category: 'Utilities',
    infoUrl: 'https://www.mercadolibre.com.ar/cinta-embalaje-fragil-48mm-x-40m-overtape/p/MLA19515907',
    imageUrls: [
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840605161085163784674960115571-wDtCCQEN3Sfpws6C0q2IndLMnbToK0.jpg'
    ],
    visibilityLevel: 4,
    baseCost: 40
  }
];

const genCode = (len = 16) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
};

/** Inserta un item v2 (phase='claim_open', status='available', sin override de fechas). */
async function insertItem(client, eventId, it) {
  await client.query(
    `INSERT INTO items
      (title, description, category, info_url, image_urls, status, phase,
       visibility_level, event_id, precio_base_costo)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'available', 'claim_open', $6, $7, $8)`,
    [
      it.title,
      it.description,
      it.category,
      it.infoUrl || null,
      JSON.stringify(it.imageUrls || []),
      it.visibilityLevel,
      eventId,
      it.baseCost
    ]
  );
}

async function main() {
  // Leer (una sola vez) los items preservados por db-reset.js antes del wipe.
  const preservedRaw = loadPreservedItems();
  const preserved = preservedRaw.map(normalizePreservedRow);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // -------------------------------------------------------------------------
    // 0a. Matriz de confianza (v2): advance_pub/disp_hours_default por rol.
    // -------------------------------------------------------------------------
    const hasV2Matrix = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'trust_levels_settings'
         AND column_name IN ('advance_pub_hours_default', 'advance_disp_hours_default')`
    );
    if (hasV2Matrix.rows[0].n === 2) {
      const matrix = [
        { id: 'familiares', pub: 72, disp: 24, mult: 0.7, max: 15 },
        { id: 'amigos', pub: 24, disp: 8, mult: 0.85, max: 5 },
        { id: 'conocidos', pub: 0, disp: 0, mult: 0.95, max: 2 },
        { id: 'publico', pub: 0, disp: 0, mult: 1.0, max: 1 }
      ];
      for (const m of matrix) {
        await client.query(
          `INSERT INTO trust_levels_settings
             (id, advance_pub_hours_default, advance_disp_hours_default,
              multiplicador_precio_default, max_apartados_simultaneos)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             advance_pub_hours_default = EXCLUDED.advance_pub_hours_default,
             advance_disp_hours_default = EXCLUDED.advance_disp_hours_default,
             multiplicador_precio_default = EXCLUDED.multiplicador_precio_default,
             max_apartados_simultaneos = EXCLUDED.max_apartados_simultaneos,
             updated_at = NOW()`,
          [m.id, m.pub, m.disp, m.mult, m.max]
        );
      }
    }

    // -------------------------------------------------------------------------
    // 0b. Plantilla de agenda global (event_config id=1)
    // -------------------------------------------------------------------------
    const hasEventConfig = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name = 'event_config'`
    );
    if (hasEventConfig.rows[0].n > 0) {
      await client.query(
        `INSERT INTO event_config
           (id, open_after_publish_hours, claims_window_hours, closing_window_hours,
            pickup_schedule_info)
         VALUES (1, 24, 72, 48, 'Entrega en sitio; el horario de recolección se coordina con el anfitrión.')
         ON CONFLICT (id) DO NOTHING`
      );
    }

    const evCount = await client.query('SELECT COUNT(*)::int AS n FROM events');
    if (evCount.rows[0].n > 0) {
      // Ya hay un evento: no re-sembrar (idempotencia). Se deja intacto el
      // archivo de preservación por si aún no se consumió.
      console.log('[SEED] Events already exist — skipping seed.');
      await client.query('ROLLBACK');
      return;
    }

    // -------------------------------------------------------------------------
    // 1. Users (UUIDs deterministas estilo navegador), uno por rol global.
    // -------------------------------------------------------------------------
    const users = [
      { uuid: '11111111-1111-4111-8111-111111111111', alias: 'AnaOwner', role: 'familiares' },
      { uuid: '22222222-2222-4222-8222-222222222222', alias: 'Marcos', role: 'amigos' },
      { uuid: '33333333-3333-4333-8333-333333333333', alias: 'Lucía', role: 'conocidos' },
      { uuid: '44444444-4444-4444-8444-444444444444', alias: 'Visitante', role: 'publico' }
    ];
    for (const u of users) {
      await client.query(
        `INSERT INTO users (uuid, alias, email, phone, global_role, bloqueado_apartar)
         VALUES ($1, $2, NULL, NULL, $3, false)
         ON CONFLICT (uuid) DO NOTHING`,
        [u.uuid, u.alias, u.role]
      );
    }

    // -------------------------------------------------------------------------
    // 2. Evento con CONTENEDOR FUTURO (eventos son del admin, sin dueño).
    //    CERO columnas por rol: las ventajas se leen dinámicas de la matriz.
    // -------------------------------------------------------------------------
    const evRes = await client.query(
      `INSERT INTO events
        (title, description, published_at, available_from, claims_close_at,
         pickup_deadline, status, pickup_schedule_info)
       VALUES ($1, $2,
               NOW() - interval '3 days', NOW() - interval '1 day',
               NOW() + interval '4 days', NOW() + interval '6 days',
               'active',
               'Entrega en sitio; el horario de recolección se coordina con el anfitrión.')
       RETURNING id`,
      ['Mudanza familiar — Regalo todo antes de partir',
       'Regalo objetos antes de mudarme. Familiares y amigos pueden reservar con anticipación; la recolección ocurre en el domicilio.']
    );
    const eventId = evRes.rows[0].id;

    // -------------------------------------------------------------------------
    // 3. Membresías por rol (sin rol, sin bonus_hours; publico NO es miembro).
    // -------------------------------------------------------------------------
    for (const u of [users[0], users[1], users[2]]) {
      await client.query(
        `INSERT INTO event_members (event_id, user_uuid, invited_by, joined_at)
         VALUES ($1, $2, NULL, NOW())`,
        [eventId, u.uuid]
      );
    }

    // -------------------------------------------------------------------------
    // 4. Códigos de invitación (1 por rol). created_by = NULL (eventos del admin).
    // -------------------------------------------------------------------------
    for (const role of ['familiares', 'amigos', 'conocidos', 'publico']) {
      await client.query(
        `INSERT INTO event_invitations (event_id, role, code, created_by, is_active)
         VALUES ($1, $2, $3, NULL, true)
         ON CONFLICT (event_id, role) DO NOTHING`,
        [eventId, role, genCode()]
      );
    }

    // -------------------------------------------------------------------------
    // 5. Items: preservados (re-captura del usuario) o demo (si no hay archivo).
    //    Todos: phase='claim_open' (reclamo abierto pre-T_inicio), status 'available'.
    // -------------------------------------------------------------------------
    const itemsToSeed = preserved.length > 0 ? preserved : DEMO_ITEMS;
    for (const it of itemsToSeed) {
      await insertItem(client, eventId, it);
    }

    await client.query('COMMIT');

    // Consumir el archivo de preservación solo tras un commit exitoso.
    if (preserved.length > 0 && fs.existsSync(PRESERVE_ITEMS_FILE)) {
      try {
        fs.rmSync(PRESERVE_ITEMS_FILE, { force: true });
        console.log(`[SEED] Removed temp file ${PRESERVE_ITEMS_FILE}`);
      } catch (err) {
        console.error('[SEED] WARN: could not remove preserved-items file:', err.message);
      }
    }

    const counts = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM events'),
      pool.query('SELECT COUNT(*)::int AS n FROM items'),
      pool.query('SELECT COUNT(*)::int AS n FROM event_members'),
      pool.query('SELECT COUNT(*)::int AS n FROM event_invitations'),
      pool.query('SELECT COUNT(*)::int AS n FROM users'),
      pool.query('SELECT COUNT(*)::int AS n FROM claims'),
      pool.query('SELECT COUNT(*)::int AS n FROM trust_levels_settings'),
      pool.query('SELECT COUNT(*)::int AS n FROM event_config')
    ]);

    console.log('[SEED] OK');
    console.log(
      `[SEED] events=${counts[0].rows[0].n}, items=${counts[1].rows[0].n}, members=${counts[2].rows[0].n}, ` +
      `invitations=${counts[3].rows[0].n}, users=${counts[4].rows[0].n}, claims=${counts[5].rows[0].n}, ` +
      `trust_levels_settings=${counts[6].rows[0].n}, event_config=${counts[7].rows[0].n}`
    );
    if (preserved.length > 0) {
      console.log(`[SEED] Inserted ${preserved.length} PRESERVED items (captura previa) under the seed event.`);
    } else {
      console.log('[SEED] No preserved-items file: inserted 5 demo items.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEED] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
