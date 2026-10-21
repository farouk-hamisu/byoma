// Minimal static file server for local testing (no dependencies).
// Also proxies /api/supabase/* to the Supabase project, mirroring the
// /api/supabase rewrite in vercel.json so local behaves like production.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);

const PROXY_PREFIX = '/api/supabase';
const PROXY_SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
]);
const PROXY_SKIP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding']);

function loadSupabaseUrl() {
  if (process.env.SUPABASE_URL) return String(process.env.SUPABASE_URL).trim().replace(/\/+$/, '');
  try {
    const envJs = readFileSync(join(root, 'env.js'), 'utf8');
    const match = /window\.__APP_CONFIG__\s*=\s*(\{[\s\S]*?\});/.exec(envJs);
    if (match) {
      const url = JSON.parse(match[1]).SUPABASE_URL;
      if (url && /^https?:\/\//.test(url)) return String(url).trim().replace(/\/+$/, '');
    }
  } catch {
    /* fall through */
  }
  try {
    const envFile = readFileSync(join(root, '.env'), 'utf8');
    const match = /^SUPABASE_URL\s*=\s*(.+)$/m.exec(envFile);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  return '';
}

const SUPABASE_BASE = loadSupabaseUrl();

async function proxyToSupabase(req, res, suffix, search) {
  if (!SUPABASE_BASE) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'X-Supabase-Proxy': '1' });
    res.end(JSON.stringify({ error: 'supabase_url_missing', message: 'Set SUPABASE_URL in .env (or run npm run env).' }));
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        res.writeHead(413).end('Payload too large');
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (PROXY_SKIP_REQUEST_HEADERS.has(key)) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  const body = method !== 'GET' && method !== 'HEAD' && chunks.length ? Buffer.concat(chunks) : undefined;

  try {
    const upstream = await fetch(`${SUPABASE_BASE}${suffix}${search}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(60000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const out = { 'X-Supabase-Proxy': '1' };
    for (const [key, value] of upstream.headers) {
      if (PROXY_SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      out[key] = value;
    }
    res.writeHead(upstream.status, out);
    res.end(buf);
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json', 'X-Supabase-Proxy': '1' });
    res.end(JSON.stringify({ error: 'proxy_error', message: 'Could not reach Supabase from the local proxy.' }));
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rawPath = url.pathname;
    if (rawPath === PROXY_PREFIX || rawPath.startsWith(`${PROXY_PREFIX}/`)) {
      const suffix = rawPath.slice(PROXY_PREFIX.length) || '/';
      await proxyToSupabase(req, res, suffix, url.search);
      return;
    }
    let pathname = decodeURIComponent(rawPath);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const filePath = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let target = filePath;
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, 'index.html');
    } catch {
      if (!extname(target)) target += '.html';
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found</p>');
  }
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});
