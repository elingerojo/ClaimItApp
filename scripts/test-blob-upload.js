/**
 * test-blob-upload.js
 * 
 * Debugging tool to verify the backend's /api/admin/blob-token endpoint
 * is responding correctly for Vercel Blob signed uploads.
 * 
 * Simulates what the @vercel/blob client SDK sends to the backend's
 * handleUploadUrl during a browser-side upload.
 * 
 * Usage:
 *   node scripts/test-blob-upload.js <ADMIN_TOKEN> [API_URL]
 * 
 * Examples:
 *   node scripts/test-blob-upload.js my-secret-token
 *   node scripts/test-blob-upload.js my-secret-token https://myapp.up.railway.app
 *   node scripts/test-blob-upload.js my-secret-token http://localhost:3000
 * 
 * Environment variables (fallback):
 *   ADMIN_TOKEN   – the admin password to authenticate
 *   API_URL       – the backend base URL (default: localhost:3000)
 */

const args = process.argv.slice(2);
const ADMIN_TOKEN = args[0] || process.env.ADMIN_TOKEN;
const API_URL = args[1] || process.env.API_URL || 'http://localhost:3000';

if (!ADMIN_TOKEN) {
  console.error('❌ Missing ADMIN_TOKEN.');
  console.error('   Provide it as the first argument or set the ADMIN_TOKEN env var.');
  console.error('');
  console.error('   Usage: node scripts/test-blob-upload.js <ADMIN_TOKEN> [API_URL]');
  process.exit(1);
}

const TEST_PATHNAME = `test-upload-${Date.now()}.jpg`;

async function testBlobToken() {
  console.log('');
  console.log('🧪  VERCEL BLOB UPLOAD TOKEN TEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Endpoint : ${API_URL}/api/admin/blob-token`);
  console.log(`  Pathname : ${TEST_PATHNAME}`);
  console.log(`  Token    : ${ADMIN_TOKEN ? '✓ provided' : '✗ missing'}`);
  console.log('');

  try {
    // Simulate the exact body shape the @vercel/blob client SDK sends
    const response = await fetch(`${API_URL}/api/admin/blob-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pathname: TEST_PATHNAME,
        clientPayload: JSON.stringify({ token: ADMIN_TOKEN }),
      }),
    });

    const duration = `${response.status}`[0] === '2' ? '✅' : '❌';

    console.log(`  HTTP ${response.status} ${response.statusText}  ${duration}`);
    console.log('');

    const body = await response.json();

    if (response.ok) {
      // Successful response – should contain a signed URL and upload token
      console.log('  ✓ Response keys:', Object.keys(body).join(', '));
      console.log('');

      if (body.url) {
        console.log('  📎  Signed upload URL:');
        console.log(`      ${body.url}`);
        console.log('');
      }
      if (body.token) {
        console.log(`  🔑  Upload token present:  ${'✓'.repeat(8)}`);
        console.log('');
      }
      if (body.uploadUrl) {
        console.log('  ⬆️  Upload endpoint:');
        console.log(`      ${body.uploadUrl}`);
        console.log('');
      }

      console.log('  ✅ SUCCESS: The backend issued a valid signed upload token.');
      console.log('     The full Vercel Blob upload pipeline is operational.');
    } else {
      // Error response
      console.log('  ⚠️  Server returned an error:');
      console.log(`     ${body.error || JSON.stringify(body)}`);
      console.log('');
      console.log('  ❌ FAILED: The backend rejected the token request.');
      console.log('     Possible causes:');
      console.log('     • Wrong ADMIN_TOKEN');
      console.log('     • BLOB_READ_WRITE_TOKEN not set on server');
      console.log('     • Backend not reachable');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

  } catch (err) {
    console.error('  💥 NETWORK ERROR:');
    console.error(`     ${err.message}`);
    console.error('');
    console.error('  Possible causes:');
    console.error('  • Backend server is not running');
    console.error('  • Wrong API_URL (missing http:// or https://)');
    console.error('  • CORS or firewall blocking the request');
    console.error('');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(1);
  }
}

testBlobToken();
