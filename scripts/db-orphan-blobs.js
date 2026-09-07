#!/usr/bin/env node
/**
 * scripts/db-orphan-blobs.js
 *
 * Etapa 1 — generates the Vercel Blob orphan list: every image_url currently
 * in the DB that is NOT one of the 5 seed items (whose images are reused).
 * Output: plans/orphan-blobs.txt
 *
 * Reads the snapshot produced by scripts/db-snapshot.js (database/.db-snapshot.json).
 * Usage: node scripts/db-orphan-blobs.js [snapshot.json] [output.txt]
 */
const fs = require('fs');
const path = require('path');

// The 5 seed items keep their Vercel Blob images (not orphaned).
const KEEP_IMAGE_URLS = [
  'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17863973008953426777157718031845-cRm36rFqHftCj1z7AwSTqMeBwrOjk5.jpg', // Audífonos Skullcandy
  'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840607625171452375709992991267-CMFJWE7IcdOjGYAALLdDZAH9188wus.jpg', // Jarrón de vidrio
  'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840782177727144257448346994374-I4ngwjcLFqmyGsuxWernpXNCXnPVyU.jpg', // Crema de Avellana
  'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840225319433966550507975701491-f27c4hv1OfqdSeR1IOKcYarSTGbGGd.jpg', // La Revolución de la Glucosa
  'https://3xpihqfobbfbdutq.public.blob.vercel-storage.com/17840605161085163784674960115571-wDtCCQEN3Sfpws6C0q2IndLMnbToK0.jpg' // Cinta de embalaje Frágil
];

function main() {
  const snapshotPath = process.argv[2] || path.join('database', '.db-snapshot.json');
  const outPath = process.argv[3] || path.join('plans', 'orphan-blobs.txt');

  if (!fs.existsSync(snapshotPath)) {
    console.error('[ORPHANS] Snapshot not found. Run: node scripts/db-snapshot.js database/.db-snapshot.json');
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const keep = new Set(KEEP_IMAGE_URLS);

  // image_urls es un arreglo JSONB por item; se aplana antes de filtrar.
  // Only real Vercel Blob URLs (exclude placeholders like example.com/x.jpg).
  const allUrls = (snapshot.items || [])
    .flatMap((i) => (Array.isArray(i.image_urls) ? i.image_urls : []))
    .filter((u) => u && u.includes('.public.blob.vercel-storage.com/'));

  const orphans = [...new Set(allUrls)].filter((u) => !keep.has(u));

  const header = [
    '# Orphaned Vercel Blob images (delete from Vercel Blob dashboard)',
    `# Generated: ${new Date().toISOString()}`,
    `# Total current distinct image_url: ${new Set(allUrls).size}`,
    `# Kept (seed items, DO NOT delete): ${KEEP_IMAGE_URLS.length}`,
    `# Orphans to delete: ${orphans.length}`,
    ''
  ];

  fs.writeFileSync(outPath, header.concat(orphans, ['']).join('\n'), 'utf8');
  console.log(`[ORPHANS] Wrote ${orphans.length} URLs to ${outPath}`);
  console.log(`[ORPHANS] Kept ${KEEP_IMAGE_URLS.length} seed images.`);
}

main();
