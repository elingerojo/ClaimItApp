#!/usr/bin/env node
/**
 * scripts/db-seed.js
 *
 * Etapa 1 — seeds the freshly rebuilt Neon schema with:
 *   - Demo users per role.
 *   - An invented moving-giveaway event with a realistic timeline that
 *     exercises the closing lifecycle (published_at / available_from past,
 *     claims_close_at +4d, pickup_deadline +6d) and per-role pickup windows.
 *   - 5 REAL items copied from the previous DB (text/category) that REUSE
 *     their Vercel Blob image_url (these 5 images are NOT orphaned).
 *   - event_memberships per role (amigos/conocidos join; publico user is a
 *     non-member to test global-role fallback) + 4 invitation codes.
 *
 * Must run AFTER a from-scratch schema rebuild (init.sql + migrations 0001-009).
 * Reads credentials from backend/.env. Idempotent-ish (guarded by ON CONFLICT
 * on users/invitations and by checking event count).
 *
 * Usage: node scripts/db-seed.js
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

const round2 = (v) => Math.round(v * 100) / 100;

const MULTIPLIERS = { familiares: 0.7, amigos: 0.85, conocidos: 0.95, publico: 1.0 };

// 5 real seed items: text/category copied from the previous DB, image_url REUSED.
const SEED_ITEMS = [
  {
    title: 'Audífonos Skullcandy Jib True Wireless',
    description:
      'Audífonos inalámbricos de color negro en buen estado, incluyen su estuche de carga original.',
    category: 'Electronics',
    infoUrl: 'https://www.google.com.mx/search?q=audifonos+skullcandy+jib+true+wireless',
    imageUrl:
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17863973008953426777157718031845-cRm36rFqHftCj1z7AwSTqMeBwrOjk5.jpg',
    visibilityLevel: 4,
    baseCost: 300
  },
  {
    title: 'Jarrón de vidrio transparente',
    description:
      'Un jarrón clásico de vidrio transparente en excelentes condiciones, ideal para arreglos florales.',
    category: 'Decor',
    infoUrl: 'https://www.google.com/search?q=jarrón+de+vidrio+transparente',
    imageUrl:
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840607625171452375709992991267-CMFJWE7IcdOjGYAALLdDZAH9188wus.jpg',
    visibilityLevel: 2,
    baseCost: 80
  },
  {
    title: 'Crema de Avellana con Cacao Keto Morama',
    description:
      'Tarro de crema de avellana con cacao tipo keto de la marca Morama. Producto sellado y en perfectas condiciones.',
    category: 'Kitchen',
    infoUrl: 'https://morama.com.mx/products/crema-de-avellana-con-cacao-keto',
    imageUrl:
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840782177727144257448346994374-I4ngwjcLFqmyGsuxWernpXNCXnPVyU.jpg',
    visibilityLevel: 3,
    baseCost: 90
  },
  {
    title: 'La Revolución de la Glucosa',
    description:
      'Libro de salud y nutrición de Jessie Inchauspé que explica cómo equilibrar los niveles de glucosa. Ejemplar en buen estado con marcas de lectura.',
    category: 'Books',
    infoUrl: 'https://www.goodreads.com/book/show/60447385-la-revoluci-n-de-la-glucosa',
    imageUrl:
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840225319433966550507975701491-f27c4hv1OfqdSeR1IOKcYarSTGbGGd.jpg',
    visibilityLevel: 4,
    baseCost: 120
  },
  {
    title: 'Cinta adhesiva de embalaje Frágil',
    description:
      "Rollo de cinta adhesiva marca Overtape con la leyenda 'Frágil', ideal para asegurar paquetes delicados durante una mudanza.",
    category: 'Utilities',
    infoUrl: 'https://www.mercadolibre.com.ar/cinta-embalaje-fragil-48mm-x-40m-overtape/p/MLA19515907',
    imageUrl:
      'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840605161085163784674960115571-wDtCCQEN3Sfpws6C0q2IndLMnbToK0.jpg',
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

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Configuración global (migración 012): event_config + columnas de la
    // matriz. Guardado: solo aplica si la migración ya existe en la BD.
    const hasEventConfig = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name = 'event_config'`
    );
    if (hasEventConfig.rows[0].n > 0) {
      await client.query(
        `INSERT INTO event_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
      );
    }
    const hasRoleDefaults = await client.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'trust_levels_settings' AND column_name = 'advance_hours_default'`
    );
    if (hasRoleDefaults.rows[0].n > 0) {
      await client.query(
        `UPDATE trust_levels_settings SET advance_hours_default = 72, share_bonus_default = 6 WHERE id = 'familiares'
           AND (advance_hours_default = 0 AND share_bonus_default = 0)`
      );
      await client.query(
        `UPDATE trust_levels_settings SET advance_hours_default = 24, share_bonus_default = 4 WHERE id = 'amigos'
           AND (advance_hours_default = 0 AND share_bonus_default = 0)`
      );
      await client.query(
        `UPDATE trust_levels_settings SET advance_hours_default = 0, share_bonus_default = 2 WHERE id = 'conocidos'
           AND (advance_hours_default = 0 AND share_bonus_default = 0)`
      );
      await client.query(
        `UPDATE trust_levels_settings SET advance_hours_default = 0, share_bonus_default = 0 WHERE id = 'publico'
           AND (advance_hours_default = 0 AND share_bonus_default = 0)`
      );
    }

    const evCount = await client.query('SELECT COUNT(*)::int AS n FROM events');
    if (evCount.rows[0].n > 0) {
      console.log('[SEED] Events already exist — skipping seed.');
      await client.query('ROLLBACK');
      return;
    }

    // 1. Users (deterministic browser-style UUIDs).
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

    // 2. Event with realistic lifecycle (los eventos son del admin, sin dueño).
    const evRes = await client.query(
      `INSERT INTO events
        (title, description, available_from, pickup_deadline, claims_close_at,
         published_at, status,
         familiares_advance_hours, amigos_advance_hours, conocidos_advance_hours, publico_advance_hours,
         familiares_share_bonus, amigos_share_bonus, conocidos_share_bonus, publico_share_bonus,
         familiares_pickup_hours, amigos_pickup_hours, conocidos_pickup_hours, publico_pickup_hours,
         pickup_window_hours, pickup_schedule_info)
       VALUES ($1, $2,
               NOW() - interval '1 day', NOW() + interval '6 days', NOW() + interval '4 days',
               NOW() - interval '3 days', 'active',
               72, 24, 0, 0,
               6, 4, 2, 0,
               48, 30, 24, 12,
               24, 'Entrega en sitio; el horario de recolección se coordina con el anfitrión.')
       RETURNING id`,
      ['Mudanza familiar — Regalo todo antes de partir',
       'Regalo objetos antes de mudarme. Familiares y amigos pueden reservar con anticipación; la recolección ocurre en el domicilio.']
    );
    const eventId = evRes.rows[0].id;

    // 3. Memberships (miembros demo que entraron por invitación; invited_by NULL).
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, joined_at)
       VALUES ($1, $2, 'familiares', NOW())`,
      [eventId, users[0].uuid]
    );
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, joined_at)
       VALUES ($1, $2, 'amigos', NOW())`,
      [eventId, users[1].uuid]
    );
    await client.query(
      `INSERT INTO event_members (event_id, user_uuid, role, joined_at)
       VALUES ($1, $2, 'conocidos', NOW())`,
      [eventId, users[2].uuid]
    );

    // 4. Invitation codes (1 per role). created_by = NULL (eventos del admin).
    for (const role of ['familiares', 'amigos', 'conocidos', 'publico']) {
      await client.query(
        `INSERT INTO event_invitations (event_id, role, code, created_by, is_active)
         VALUES ($1, $2, $3, NULL, true)
         ON CONFLICT (event_id, role) DO NOTHING`,
        [eventId, role, genCode()]
      );
    }

    // 5. Items: copy the 5 real seed items, reuse image_url, snap prices by role.
    for (const it of SEED_ITEMS) {
      const fam = round2(it.baseCost * MULTIPLIERS.familiares);
      const ami = round2(it.baseCost * MULTIPLIERS.amigos);
      const con = round2(it.baseCost * MULTIPLIERS.conocidos);
      const pub = round2(it.baseCost * MULTIPLIERS.publico);
      await client.query(
        `INSERT INTO items
          (title, description, category, info_url, image_url, status, visibility_level,
           event_id, visible_at, available_from, expires_at,
           precio_base_costo, precio_familiar, precio_amigo, precio_conocido, precio_publico,
           horas_recoleccion_familiar, horas_recoleccion_amigo, horas_recoleccion_conocido, horas_recoleccion_publico,
           nivel_acceso_minimo)
         VALUES ($1, $2, $3, $4, $5, 'available', $6, $7,
                 NULL, NULL, NULL,
                 $8, $9, $10, $11, $12,
                 NULL, NULL, NULL, NULL,
                 'publico')`,
        [it.title, it.description, it.category, it.infoUrl || null, it.imageUrl,
         it.visibilityLevel, eventId,
         it.baseCost, fam, ami, con, pub]
      );
    }

    await client.query('COMMIT');

    const counts = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM events'),
      pool.query('SELECT COUNT(*)::int AS n FROM items'),
      pool.query('SELECT COUNT(*)::int AS n FROM event_members'),
      pool.query('SELECT COUNT(*)::int AS n FROM users'),
      pool.query('SELECT COUNT(*)::int AS n FROM claims')
    ]);

    console.log('[SEED] OK');
    console.log(`[SEED] events=${counts[0].rows[0].n}, items=${counts[1].rows[0].n}, members=${counts[2].rows[0].n}, users=${counts[3].rows[0].n}, claims=${counts[4].rows[0].n}`);
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
