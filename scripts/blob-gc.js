#!/usr/bin/env node
/**
 * scripts/blob-gc.js
 *
 * Garbage collector for the Vercel Blob store that backs item photos.
 *
 * What it does (READ-ONLY unless --delete is passed):
 *   1. Reads every image URL referenced by Neon (items.image_urls JSONB) and
 *      normalizes each one to a Blob pathname.
 *   2. Paginates the whole Blob store with the server SDK `list()`.
 *   3. Classifies every blob as keep / skip-recent / orphan.
 *   4. Writes a reviewable report BEFORE touching anything:
 *      plans/blob-gc-report.json + plans/blob-gc-orphans.txt
 *   5. Only with --delete, removes the orphan candidates in batches of 50.
 *
 * Why the grace window exists: the admin ingest flow uploads client-side
 * straight to Blob (@vercel/blob/client in admin-ingest.ts) and only records
 * the URL in Neon when the item is saved. A blob that is minutes old can
 * therefore belong to an in-flight form. Anything uploaded more recently than
 * --grace-hours (default 24) is never treated as an orphan.
 *
 * Safety model:
 *   - dry-run is the default; del() is unreachable without --delete;
 *   - aborts when BLOB_READ_WRITE_TOKEN or the DATABASE_* vars are missing;
 *   - aborts when Neon returns zero referenced URLs (unless --allow-empty-db),
 *     because that points at a connection or schema problem, not an empty
 *     store, and would otherwise orphan the entire store;
 *   - compares normalized pathnames, so ?query suffixes or a different store
 *     host can never produce a false orphan;
 *   - warns loudly when referenced URLs point at a host other than the scanned
 *     store, and when orphans outnumber kept blobs;
 *   - the report is written before any deletion.
 *
 * Usage (from the repo root):
 *   node scripts/blob-gc.js                            # dry run, 24h grace
 *   node scripts/blob-gc.js --grace-hours=168 --verbose
 *   node scripts/blob-gc.js --prefix=uploads/          # limit blast radius
 *   node scripts/blob-gc.js --delete                   # actually delete
 *
 * Options:
 *   --delete              Perform deletions (default: dry run, report only)
 *   --grace-hours=N       Protect blobs uploaded less than N hours ago (24)
 *   --prefix=PATH         Scan only blobs whose pathname starts with PATH
 *   --report=PATH         Report path (default plans/blob-gc-report.json)
 *   --keep-file=PATH      Extra URLs/pathnames that must never be deleted.
 *                         Accepts a JSON array, {"keep": [...]}, {"urls": [...]}
 *                         or a plain text list (one entry per line, # comments)
 *   --env=PATH            Env file to load (default: backend/.env)
 *   --allow-empty-db      Continue even when Neon reports zero referenced URLs
 *   --verbose             Print every classification decision
 *
 * Pre-flight checks (all abort before listing anything):
 *   - the env file, the DATABASE_* vars and BLOB_READ_WRITE_TOKEN must exist;
 *   - the token must have the real shape vercel_blob_rw_<storeId>_<secret>, so
 *     placeholder values fail with a clear message instead of the SDK's
 *     misleading "This store does not exist";
 *   - the token's store id must match the store the Neon URLs point at.
 *
 * Reads credentials from backend/.env (same vars as db-snapshot.js / db.ts):
 *   DATABASE_USERNAME, DATABASE_HOST, DATABASE_NAME, DATABASE_PASSWORD,
 *   DATABASE_PORT, DATABASE_SSL, BLOB_READ_WRITE_TOKEN
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(REPO_ROOT, 'backend', '.env');
const DEFAULT_REPORT = path.join(REPO_ROOT, 'plans', 'blob-gc-report.json');
const DEFAULT_GRACE_HOURS = 24;
const DELETE_BATCH_SIZE = 50;
const LIST_PAGE_SIZE = 1000;

// Matches both public and private Vercel Blob hosts.
const BLOB_HOST_RE = /^https?:\/\/([^/]+)\.blob\.vercel-storage\.com\/(.+)$/i;

/**
 * Extracts the store id from a `vercel_blob_rw_<storeId>_<secret>` token.
 * Returns null when the value is not a well-formed Blob token, which is how
 * placeholder values such as "vercel_blob_rw_your_secret_token_here" are
 * detected before any network call is attempted.
 */
function storeIdFromToken(token) {
  const parts = String(token || '')
    .replace(/["']/g, '')
    .trim()
    .split('_');
  if (parts.length < 5 || parts[0] !== 'vercel' || parts[1] !== 'blob') return null;
  const storeId = parts[3];
  return /^[a-z0-9]{6,}$/i.test(storeId) ? storeId : null;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    delete: false,
    graceHours: DEFAULT_GRACE_HOURS,
    prefix: null,
    report: DEFAULT_REPORT,
    keepFile: null,
    env: null,
    allowEmptyDb: false,
    verbose: false
  };

  for (const raw of argv) {
    const [flag, inlineValue] = raw.split('=');
    const value = inlineValue !== undefined ? inlineValue : null;

    switch (flag) {
      case '--delete':
        opts.delete = true;
        break;
      case '--grace-hours': {
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours < 0) {
          throw new Error(`Invalid --grace-hours value: ${raw}`);
        }
        opts.graceHours = hours;
        break;
      }
      case '--prefix':
        if (!value) throw new Error(`Missing value for --prefix (use --prefix=folder/)`);
        opts.prefix = value;
        break;
      case '--report':
        if (!value) throw new Error(`Missing value for --report (use --report=plans/file.json)`);
        opts.report = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        break;
      case '--keep-file':
        if (!value) throw new Error(`Missing value for --keep-file (use --keep-file=path.json)`);
        opts.keepFile = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        break;
      case '--env':
        if (!value) throw new Error(`Missing value for --env (use --env=.env.production)`);
        opts.env = path.isAbsolute(value) ? value : path.join(REPO_ROOT, value);
        break;
      case '--allow-empty-db':
        opts.allowEmptyDb = true;
        break;
      case '--verbose':
        opts.verbose = true;
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
  console.log('  Usage: node scripts/blob-gc.js [options]');
  console.log('');
  console.log('    --delete            Delete orphan blobs (default: dry run)');
  console.log('    --grace-hours=N     Protect blobs newer than N hours (default: 24)');
  console.log('    --prefix=PATH       Only scan blobs under this pathname prefix');
  console.log('    --report=PATH       Report path (default: plans/blob-gc-report.json)');
  console.log('    --keep-file=PATH    Extra URLs/pathnames to never delete');
  console.log('    --env=PATH          Env file to load (default: backend/.env)');
  console.log('    --allow-empty-db    Continue when Neon returns zero image URLs');
  console.log('    --verbose           Print every classification decision');
  console.log('');
}

// ---------------------------------------------------------------------------
// Pathname normalization
// ---------------------------------------------------------------------------

/**
 * Converts a Neon image URL (or a raw pathname) into a Blob pathname so both
 * sides of the comparison use the same key. Returns null for entries that do
 * not belong to a Vercel Blob host.
 */
function toBlobPathname(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  let pathname;
  const match = raw.match(BLOB_HOST_RE);
  if (match) {
    pathname = match[2];
  } else if (/^https?:\/\//i.test(raw)) {
    return null; // foreign host: placeholder, CDN or legacy store
  } else {
    pathname = raw; // already a pathname
  }

  pathname = pathname.split('?')[0].split('#')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep the raw value when it is not valid percent-encoding */
  }
  return pathname || null;
}

function blobHostOf(url) {
  const match = typeof url === 'string' ? url.match(BLOB_HOST_RE) : null;
  return match ? `${match[1]}.blob.vercel-storage.com` : null;
}

// ---------------------------------------------------------------------------
// Keep-list loading
// ---------------------------------------------------------------------------

function loadKeepFile(filePath) {
  if (!filePath) return [];
  if (!fs.existsSync(filePath)) {
    throw new Error(`--keep-file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let entries = [];

  if (filePath.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) entries = parsed;
    else if (Array.isArray(parsed.keep)) entries = parsed.keep;
    else if (Array.isArray(parsed.urls)) entries = parsed.urls;
    else throw new Error(`--keep-file JSON must be an array or expose "keep"/"urls"`);
  } else {
    entries = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  return entries.filter((entry) => typeof entry === 'string');
}

// ---------------------------------------------------------------------------
// Neon references
// ---------------------------------------------------------------------------

async function fetchReferencedUrls(pool) {
  const result = await pool.query(
    `SELECT DISTINCT (elem #>> '{}') AS url
       FROM items AS i
       CROSS JOIN LATERAL jsonb_array_elements(i.image_urls) AS elem
      WHERE jsonb_typeof(elem) = 'string'
        AND btrim(elem #>> '{}') <> ''
      ORDER BY 1`
  );
  return result.rows.map((row) => row.url);
}

// ---------------------------------------------------------------------------
// Blob store scan
// ---------------------------------------------------------------------------

async function scanStore({ token, prefix, verbose }) {
  const blobs = [];
  let cursor;
  let pages = 0;

  do {
    const page = await listBlobs({ token, prefix, cursor });
    blobs.push(...page.blobs);
    pages += 1;
    cursor = page.hasMore ? page.cursor : undefined;
    if (verbose) {
      console.log(`   … page ${pages}: +${page.blobs.length} (total ${blobs.length})`);
    }
  } while (cursor);

  return blobs;
}

async function listBlobs({ token, prefix, cursor }) {
  const options = { token, limit: LIST_PAGE_SIZE };
  if (prefix) options.prefix = prefix;
  if (cursor) options.cursor = cursor;
  return blobSdk.list(options);
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

async function deleteWithRetry(pathnames, token, verbose, attempt = 0) {
  try {
    await blobSdk.del(pathnames, { token });
  } catch (error) {
    const retryAfter = Number(error && error.retryAfter);
    if (Number.isFinite(retryAfter) && attempt === 0) {
      const waitMs = Math.max(1, retryAfter) * 1000;
      console.warn(`   … rate limited, retrying in ${waitMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return deleteWithRetry(pathnames, token, verbose, attempt + 1);
    }
    throw error;
  }
}

async function deleteOrphans(pathnames, token, verbose) {
  const deleted = [];
  const errors = [];

  for (let i = 0; i < pathnames.length; i += DELETE_BATCH_SIZE) {
    const batch = pathnames.slice(i, i + DELETE_BATCH_SIZE);
    try {
      await deleteWithRetry(batch, token, verbose);
      deleted.push(...batch);
      if (verbose) console.log(`   … deleted batch of ${batch.length}`);
    } catch (error) {
      // Fall back to one-by-one so a single bad blob cannot block the batch.
      console.warn(`   ! batch failed (${error.message}); retrying individually`);
      for (const pathname of batch) {
        try {
          await deleteWithRetry([pathname], token, verbose);
          deleted.push(pathname);
        } catch (innerError) {
          errors.push({ pathname, message: innerError.message });
          console.error(`   ✗ ${pathname}: ${innerError.message}`);
        }
      }
    }
  }

  return { deleted, errors };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function writeReports({ reportPath, report, orphans }) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  // blob-gc-report.json -> blob-gc-orphans.txt (documented name); custom report
  // names simply gain the same -orphans suffix.
  const txtPath = reportPath.replace(/\.json$/i, '').replace(/-report$/, '') + '-orphans.txt';
  const lines = [
    '# Vercel Blob GC — orphan candidates',
    `# Generated: ${report.generatedAt}`,
    `# Mode: ${report.mode}${report.mode === 'dry-run' ? ' (nothing was deleted)' : ''}`,
    `# Store: ${report.store.host || 'unknown'}${report.store.prefix ? ` prefix=${report.store.prefix}` : ''}`,
    `# Grace window: ${report.graceHours}h (blobs newer than this are never listed here)`,
    `# Scanned: ${report.totals.blobsScanned} blobs (${formatBytes(report.totals.bytesScanned)})`,
    `# Kept by Neon: ${report.totals.keep}`,
    `# Skipped (too recent): ${report.totals.skipRecent}`,
    `# Orphans: ${report.totals.orphans} (${formatBytes(report.totals.bytesOrphans)})`,
    '',
    ...orphans.map((blob) => `${blob.url}   # ${blob.uploadedAt} ${formatBytes(blob.size)}`),
    ''
  ];
  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');
  return txtPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let blobSdk;

function assertEnvironment(envFile) {
  const missing = ['DATABASE_USERNAME', 'DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_PASSWORD'].filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(', ')} in ${envFile}. ` +
        `These are the same vars used by db-snapshot.js / db.ts.`
    );
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      `Missing BLOB_READ_WRITE_TOKEN in ${envFile}. ` +
        `Copy it from Vercel → Storage → your Blob store → .env.local snippet, ` +
        `or pass the file that holds it with --env=PATH.`
    );
  }

  if (!storeIdFromToken(process.env.BLOB_READ_WRITE_TOKEN)) {
    throw new Error(
      `BLOB_READ_WRITE_TOKEN in ${envFile} is not a usable Vercel Blob token (expected the ` +
        `shape vercel_blob_rw_<storeId>_<secret>). Placeholder values such as ` +
        `"vercel_blob_rw_your_secret_token_here" cannot list or delete blobs and would fail ` +
        `later with the misleading error "This store does not exist". Paste the real token from ` +
        `Vercel → Storage → your Blob store → .env.local snippet, or point the script at the ` +
        `file that holds it with --env=PATH.`
    );
  }
}

async function main() {
  const startedAt = Date.now();
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printUsage();
    return;
  }

  const envFile = opts.env || ENV_FILE;
  if (!fs.existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}`);
  }

  dotenv.config({ path: envFile, override: true });
  assertEnvironment(envFile);

  blobSdk = require('@vercel/blob');
  if (typeof blobSdk.list !== 'function' || typeof blobSdk.del !== 'function') {
    throw new Error(
      'Installed @vercel/blob does not expose list()/del(). Expected the server SDK v2 ' +
        '(backend dependency, hoisted to the root node_modules).'
    );
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const mode = opts.delete ? 'delete' : 'dry-run';

  console.log('');
  console.log('🧹  VERCEL BLOB GARBAGE COLLECTION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Mode         : ${mode}${opts.delete ? '  ⚠️  DELETIONS WILL RUN' : '  (report only)'}`);
  console.log(`  Env file     : ${envFile}`);
  console.log(`  Grace window : ${opts.graceHours}h`);
  console.log(`  Prefix       : ${opts.prefix || '(whole store)'}`);
  console.log(`  Report       : ${opts.report}`);
  console.log('');

  const pool = new Pool({
    user: process.env.DATABASE_USERNAME,
    host: process.env.DATABASE_HOST,
    database: process.env.DATABASE_NAME,
    password: process.env.DATABASE_PASSWORD,
    port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : 5432,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000
  });

  try {
    console.log('  [1/4] Reading referenced image URLs from Neon …');
    const referencedUrls = await fetchReferencedUrls(pool);
    const keepEntries = loadKeepFile(opts.keepFile);

    const keepPathnames = new Set();
    const foreignRefs = [];
    let unparsedRefs = 0;

    for (const url of referencedUrls) {
      const pathname = toBlobPathname(url);
      if (pathname) keepPathnames.add(pathname);
      else unparsedRefs += 1;
    }
    for (const entry of keepEntries) {
      const pathname = toBlobPathname(entry);
      if (pathname) keepPathnames.add(pathname);
    }

    console.log(
      `        Neon URLs: ${referencedUrls.length} → ${keepPathnames.size} distinct pathnames` +
        (keepEntries.length ? ` (+${keepEntries.length} from --keep-file)` : '')
    );

    // Pre-flight: the token must belong to the same store the DB points at,
    // otherwise the scan compares two different stores and every blob in the
    // scanned store would look like an orphan.
    const tokenStoreId = storeIdFromToken(token);
    const neonHostPrefixes = [
      ...new Set(referencedUrls.map((url) => blobHostOf(url)).filter(Boolean))
    ].map((urlHost) => urlHost.split('.')[0]);

    // Store ids keep their original casing inside the token but the public host
    // is always lowercase (token "3xpIhQFObbFbdutq" == host "3xpihqfobbfbdutq"),
    // so the comparison must ignore case.
    const sameStore = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

    if (neonHostPrefixes.length === 1 && !sameStore(neonHostPrefixes[0], tokenStoreId)) {
      throw new Error(
        `Store mismatch: BLOB_READ_WRITE_TOKEN belongs to store "${tokenStoreId}" but Neon ` +
          `references "${neonHostPrefixes[0]}". Refusing to run, because listing the token's ` +
          `store would classify every blob as an orphan.`
      );
    }
    if (neonHostPrefixes.length > 1) {
      console.warn(
        `  ⚠️  Neon references ${neonHostPrefixes.length} different Blob stores: ` +
          neonHostPrefixes.join(', ')
      );
    }

    if (referencedUrls.length === 0 && !opts.allowEmptyDb) {
      throw new Error(
        'Neon returned zero referenced image URLs. Refusing to continue because every blob ' +
          'would be classified as an orphan. Check the DATABASE_* credentials, or pass ' +
          '--allow-empty-db if the store really should be emptied.'
      );
    }

    console.log(`  [2/4] Scanning the Blob store${opts.prefix ? ` (prefix ${opts.prefix})` : ''} …`);
    const blobs = await scanStore({ token, prefix: opts.prefix, verbose: opts.verbose });
    const host = blobs.length > 0 ? blobHostOf(blobs[0].url) : null;
    console.log(`        Found ${blobs.length} blobs${host ? ` on ${host}` : ''}`);

    console.log('  [3/4] Classifying …');
    const now = Date.now();
    const graceMs = opts.graceHours * 3600 * 1000;

    const keep = [];
    const skipRecent = [];
    const orphans = [];
    let bytesScanned = 0;
    let bytesSkipRecent = 0;
    let bytesOrphans = 0;

    for (const blob of blobs) {
      const uploadedAt = new Date(blob.uploadedAt);
      const record = {
        pathname: blob.pathname,
        url: blob.url,
        size: blob.size,
        uploadedAt: uploadedAt.toISOString()
      };
      bytesScanned += blob.size;

      if (keepPathnames.has(blob.pathname)) {
        keep.push(record);
      } else if (graceMs > 0 && uploadedAt.getTime() > now - graceMs) {
        skipRecent.push(record);
        bytesSkipRecent += blob.size;
      } else {
        orphans.push(record);
        bytesOrphans += blob.size;
      }
    }

    // A referenced URL living on another host means the DB may point at a
    // different store than the one behind BLOB_READ_WRITE_TOKEN.
    if (host) {
      for (const url of referencedUrls) {
        const urlHost = blobHostOf(url);
        if (urlHost && urlHost !== host) foreignRefs.push(url);
      }
    }

    orphans.sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : a.uploadedAt > b.uploadedAt ? 1 : 0));

    if (opts.verbose) {
      for (const record of keep) console.log(`        keep        ${record.pathname}`);
      for (const record of skipRecent) console.log(`        skip-recent ${record.pathname}`);
      for (const record of orphans) console.log(`        orphan      ${record.pathname}`);
    }

    const warnings = [];
    if (foreignRefs.length > 0) {
      warnings.push(
        `${foreignRefs.length} referenced URL(s) live on a host other than ${host}: ${foreignRefs
          .slice(0, 3)
          .join(', ')}${foreignRefs.length > 3 ? ' …' : ''}`
      );
    }
    if (unparsedRefs > 0) {
      warnings.push(`${unparsedRefs} referenced URL(s) are not Vercel Blob URLs and were ignored`);
    }
    if (blobs.length >= 4 && orphans.length > keep.length && opts.delete) {
      warnings.push(
        `orphans (${orphans.length}) outnumber kept blobs (${keep.length}) — verify the store host and Neon database before trusting this run`
      );
    }

    // --- Report is always written before any deletion -----------------------
    const report = {
      generatedAt: new Date().toISOString(),
      mode,
      store: { host, prefix: opts.prefix, tokenStoreId, neonHostPrefixes, envFile },
      graceHours: opts.graceHours,
      totals: {
        blobsScanned: blobs.length,
        bytesScanned,
        dbUrlsRead: referencedUrls.length,
        keptPathnames: keepPathnames.size,
        keep: keep.length,
        skipRecent: skipRecent.length,
        bytesSkipRecent,
        orphans: orphans.length,
        bytesOrphans,
        deleted: 0,
        deleteFailures: 0
      },
      warnings,
      keep,
      skipRecent,
      orphans,
      deleted: [],
      errors: []
    };

    console.log('  [4/4] Writing report …');
    const txtPath = writeReports({
      reportPath: opts.report,
      report,
      orphans
    });
    console.log(`        ${opts.report}`);
    console.log(`        ${txtPath}`);

    for (const warning of warnings) console.warn(`  ⚠️  ${warning}`);

    if (opts.delete && orphans.length > 0) {
      console.log('');
      console.log(`  Deleting ${orphans.length} orphan blob(s) in batches of ${DELETE_BATCH_SIZE} …`);
      const { deleted, errors } = await deleteOrphans(
        orphans.map((blob) => blob.pathname),
        token,
        opts.verbose
      );

      report.totals.deleted = deleted.length;
      report.totals.deleteFailures = errors.length;
      report.deleted = deleted;
      report.errors = errors;
      fs.writeFileSync(opts.report, JSON.stringify(report, null, 2), 'utf8');

      console.log(`        deleted ${deleted.length}, failed ${errors.length}`);
    } else if (opts.delete) {
      console.log('');
      console.log('  Deleting: nothing to do (no orphan candidates).');
    }

    // --- Summary -----------------------------------------------------------
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Scanned        : ${blobs.length} blobs (${formatBytes(bytesScanned)})`);
    console.log(`  Kept by Neon   : ${keep.length}`);
    console.log(`  Skipped recent : ${skipRecent.length} (${formatBytes(bytesSkipRecent)})`);
    console.log(`  Orphans        : ${orphans.length} (${formatBytes(bytesOrphans)})`);
    if (opts.delete) {
      console.log(`  Deleted        : ${report.totals.deleted}`);
      console.log(`  Failures       : ${report.totals.deleteFailures}`);
    } else if (orphans.length > 0) {
      console.log('');
      console.log('  Dry run — nothing was deleted. Review the report, then re-run with --delete.');
    }
    console.log(`  Elapsed        : ${elapsed}s`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    if (report.totals.deleteFailures > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('');
  console.error(`[BLOB-GC] Failed: ${error.message}`);
  console.error('');
  process.exit(1);
});
