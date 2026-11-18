/**
 * Minimal Blossom mock server for E2E tests.
 *
 * Implements:
 *   PUT /upload  — store blob keyed by ciphertext SHA-256, return { url }
 *   GET /:sha256 — serve blob bytes or 404
 *   GET /healthz — liveness probe (200 ok)
 *
 * Usage: node scripts/blossom-mock.mjs [port]
 * Default port: 3001
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = parseInt(process.env.BLOSSOM_MOCK_PORT ?? process.argv[2] ?? '3001', 10);
const HOST = process.env.BLOSSOM_MOCK_HOST ?? '0.0.0.0';

// In-memory blob store: sha256hex → Buffer
const store = new Map();

// Test-control flag: when set, PUT /upload returns 500 so E2E tests can
// exercise the failure-and-retry UI flow. Toggled via /admin/fail-uploads
// and /admin/clear-failures.
let failUploads = false;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-SHA-256');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Test-control endpoints (no auth — mock is only reachable in E2E env).
  if (req.method === 'POST' && url.pathname === '/admin/fail-uploads') {
    failUploads = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/admin/clear-failures') {
    failUploads = false;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // PUT /upload — store blob
  if (req.method === 'PUT' && url.pathname === '/upload') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (failUploads) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated upload failure' }));
        return;
      }
      const body = Buffer.concat(chunks);
      const hash = sha256(body);
      store.set(hash, body);

      const serverHost = req.headers['x-forwarded-proto'] === 'https'
        ? `https://${req.headers.host}`
        : `http://localhost:${PORT}`;
      const blobUrl = `${serverHost}/${hash}`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: blobUrl, sha256: hash, size: body.length }));
    });
    req.on('error', () => {
      res.writeHead(500);
      res.end('Upload error');
    });
    return;
  }

  // GET /:sha256 — serve blob
  if (req.method === 'GET' && url.pathname.length > 1) {
    const hash = url.pathname.slice(1);
    const blob = store.get(hash);
    if (!blob) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(blob.length),
    });
    res.end(blob);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[blossom-mock] Listening on ${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
