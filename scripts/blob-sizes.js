#!/usr/bin/env node
/**
 * scripts/blob-sizes.js
 *
 * Read-only size report for the Vercel Blob store that backs item photos.
 * It never writes to the store: it only lists blobs and aggregates sizes, so it
 * is safe to run at any time (before/after a capture session, or to check whether
 * an external optimization already shrank the existing photos).
 *
 * What it prints:
 *   1. Global totals: blobs, bytes and average size per blob.
 *   2. A size histogram (<=250 KB, <=500 KB, <=1 MB, <=2 MB, >2 MB).
 *   3. A per-folder breakdown (pathname up to the last "/"), sorted by bytes.
 *      Root-level blobs — the legacy naming produced before the `event-AAAAMMDD/`
 *      prefix — are grouped as "(raíz)" so they are easy to spot.
 *   4. With --details, the size of every individual blob.
 *
 * Why it exists: the admin capture flow optimizes photos on the phone before the
 * signed upload, so new blobs should land under `event-AAAAMMDD/` at ~200 KB
 * while legacy blobs sit at the root with their original ~1.9 MB. This report is
 * how both realities are verified without guessing.
 *
 * Usage (from the repo root):
 *   node scripts/blob-sizes.js
 *   node scripts/blob-sizes.js --prefix=event-2026
 *   node scripts/blob-sizes.js --top=50 --details
 *   node scripts/blob-sizes.js --report=plans/blob-sizes-report.json
 *
 * Options:
 *   --prefix=PATH    Only scan blobs whose pathname starts with PATH
 *   --top=N          How many folders to list (default 20; 0 = all)
 *   --details        Print every blob size
 *   --report=PATH    Also write the aggregation as JSON
 *   --env=PATH       Env file to load (default: backend/.env)
 *
 * Reads credentials from backend/.env (same vars as blob-gc.js):
 *   BLOB_READ_WRITE_TOKEN
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(REPO_ROOT, 'backend', '.env');
const LIST_PAGE_SIZE = 1000;
const TOP_POR_DEFECTO = 20;

let blobSdk = null;

const BUCKETS = [
  { label: '<= 250 KB', max: 250 * 1024 },
  { label: '<= 500 KB', max: 500 * 1024 },
  { label: '<= 1 MB', max: 1024 * 1024 },
  { label: '<= 2 MB', max: 2 * 1024 * 1024 },
  { label: '> 2 MB', max: Infinity }
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { prefix: null, top: TOP_POR_DEFECTO, details: false, report: null, env: null };

  for (const raw of argv) {
    const [flag, inlineValue] = raw.split('=');
    const value = inlineValue !== undefined ? inlineValue : null;

    switch (flag) {
      case '--prefix':
        if (!value) throw new Error('Missing value for --prefix (use --prefix=event-2026)');
        opts.prefix = value;
        break;
      case '--top': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --top value: ${raw}`);
        opts.top = Math.floor(n);
        break;
      }
      case '--details':
        opts.details = true;
        break;
      case '--report':
        if (!value) throw new Error('Missing value for --report (use --report=plans/file.json)');
        opts.report = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        break;
      case '--env':
        if (!value) throw new Error('Missing value for --env (use --env=.env.production)');
        opts.env = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${raw}`);
    }
  }

  return opts;
}

function printUsage() {
  console.log('');
  console.log('  Usage: node scripts/blob-sizes.js [options]');
  console.log('');
  console.log('    --prefix=PATH    Only scan blobs under this pathname prefix');
  console.log('    --top=N          How many folders to list (default 20; 0 = all)');
  console.log('    --details        Print every blob size');
  console.log('    --report=PATH    Also write the aggregation as JSON');
  console.log('    --env=PATH       Env file to load (default: backend/.env)');
  console.log('');
}

/**
 * Same guard as blob-gc.js: a placeholder token produces the SDK's misleading
 * "This store does not exist", so it is rejected up front with a clear message.
 */
function assertEnvironment(envFile) {
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || '').replace(/["']/g, '').trim();
  if (!token) {
    throw new Error(`BLOB_READ_WRITE_TOKEN is missing. Add it to ${envFile} or pass --env=PATH.`);
  }
  if (/your_secret_token_here|placeholder/i.test(token)) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN looks like a placeholder. Paste the real token from ' +
        'Vercel → Storage → your Blob store.'
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** Folder of a pathname: everything before the last "/" ("(raíz)" at the root). */
function folderOf(pathname) {
  const idx = pathname.lastIndexOf('/');
  return idx > 0 ? pathname.slice(0, idx) : '(raíz)';
}

function extensionOf(pathname) {
  const match = /\.[^./\\]+$/.exec(pathname);
  return match ? match[0].toLowerCase() : '(sin extensión)';
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)));
  return sorted[index];
}

async function listBlobs({ token, prefix, cursor }) {
  const options = { token, limit: LIST_PAGE_SIZE };
  if (prefix) options.prefix = prefix;
  if (cursor) options.cursor = cursor;
  return blobSdk.list(options);
}

async function scanStore({ token, prefix }) {
  const blobs = [];
  let cursor;

  do {
    const page = await listBlobs({ token, prefix, cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

function agregar(grupos, clave, blob) {
  const actual = grupos.get(clave) || { clave, blobs: 0, bytes: 0 };
  actual.blobs += 1;
  actual.bytes += blob.size;
  grupos.set(clave, actual);
  return actual;
}

function resumirGrupos(grupos) {
  return [...grupos.values()]
    .map((grupo) => ({ ...grupo, average: grupo.blobs ? grupo.bytes / grupo.blobs : 0 }))
    .sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return;
  }

  const envFile = opts.env || ENV_FILE;
  if (!fs.existsSync(envFile)) throw new Error(`Env file not found: ${envFile}`);

  dotenv.config({ path: envFile, override: true });
  assertEnvironment(envFile);

  blobSdk = require('@vercel/blob');
  if (typeof blobSdk.list !== 'function') {
    throw new Error(
      'Installed @vercel/blob does not expose list(). Expected the server SDK v2 ' +
        '(backend dependency, hoisted to the root node_modules).'
    );
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;

  console.log('');
  console.log('📏  VERCEL BLOB SIZE REPORT (read-only)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Env file : ${envFile}`);
  console.log(`  Prefix   : ${opts.prefix || '(whole store)'}`);
  console.log('');

  const blobs = await scanStore({ token, prefix: opts.prefix });
  const bytesTotal = blobs.reduce((sum, blob) => sum + blob.size, 0);
  const tamanos = blobs.map((blob) => blob.size).sort((a, b) => a - b);

  const carpetas = new Map();
  const extensiones = new Map();
  const buckets = BUCKETS.map((bucket) => ({ ...bucket, blobs: 0, bytes: 0 }));

  for (const blob of blobs) {
    agregar(carpetas, folderOf(blob.pathname), blob);
    agregar(extensiones, extensionOf(blob.pathname), blob);
    const bucket = buckets.find((b) => blob.size <= b.max);
    bucket.blobs += 1;
    bucket.bytes += blob.size;
  }

  const resumen = {
    generatedAt: new Date().toISOString(),
    prefix: opts.prefix,
    totals: {
      blobs: blobs.length,
      bytes: bytesTotal,
      average: blobs.length ? bytesTotal / blobs.length : 0,
      min: tamanos.length ? tamanos[0] : 0,
      p50: percentile(tamanos, 0.5),
      p90: percentile(tamanos, 0.9),
      max: tamanos.length ? tamanos[tamanos.length - 1] : 0
    },
    buckets: buckets.map(({ label, blobs: n, bytes }) => ({ label, blobs: n, bytes })),
    folders: resumirGrupos(carpetas),
    extensions: resumirGrupos(extensiones)
  };

  if (blobs.length === 0) {
    console.log('  No blobs found for this prefix.');
    console.log('');
    return;
  }

  console.log(`  Blobs     : ${resumen.totals.blobs}`);
  console.log(`  Total     : ${formatBytes(bytesTotal)}`);
  console.log(`  Promedio  : ${formatBytes(resumen.totals.average)} por foto`);
  console.log(
    `  Min/p50/p90/max : ${formatBytes(resumen.totals.min)} / ${formatBytes(
      resumen.totals.p50
    )} / ${formatBytes(resumen.totals.p90)} / ${formatBytes(resumen.totals.max)}`
  );
  console.log('');

  console.log('  Distribución por peso');
  for (const bucket of resumen.buckets) {
    const porcentaje = ((bucket.blobs / resumen.totals.blobs) * 100).toFixed(0);
    console.log(
      `    ${bucket.label.padEnd(10)} ${String(bucket.blobs).padStart(5)} blobs  ` +
        `${formatBytes(bucket.bytes).padStart(10)}  (${porcentaje}%)`
    );
  }
  console.log('');

  const top = opts.top === 0 ? resumen.folders : resumen.folders.slice(0, opts.top);
  console.log(`  Carpetas (top ${top.length} de ${resumen.folders.length}, por bytes)`);
  for (const folder of top) {
    const marca = folder.clave === '(raíz)' ? '  ⚠️  legacy sin prefijo' : '';
    console.log(
      `    ${folder.clave.padEnd(28)} ${String(folder.blobs).padStart(5)} blobs  ` +
        `${formatBytes(folder.bytes).padStart(10)}  prom ${formatBytes(folder.average)}${marca}`
    );
  }
  console.log('');

  console.log('  Tipos de archivo');
  for (const ext of resumen.extensions) {
    console.log(
      `    ${ext.clave.padEnd(16)} ${String(ext.blobs).padStart(5)} blobs  ` +
        `${formatBytes(ext.bytes).padStart(10)}  prom ${formatBytes(ext.average)}`
    );
  }
  console.log('');

  if (opts.details) {
    console.log('  Detalle por blob (pathname  tamaño  subido)');
    const ordenados = [...blobs].sort((a, b) => b.size - a.size);
    for (const blob of ordenados) {
      console.log(
        `    ${formatBytes(blob.size).padStart(10)}  ${blob.uploadedAt}  ${blob.pathname}`
      );
    }
    console.log('');
  }

  if (opts.report) {
    fs.mkdirSync(path.dirname(opts.report), { recursive: true });
    fs.writeFileSync(opts.report, JSON.stringify(resumen, null, 2), 'utf8');
    console.log(`  Reporte JSON: ${opts.report}`);
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error(`[BLOB-SIZES] Failed: ${error.message}`);
  console.error('');
  process.exit(1);
});
