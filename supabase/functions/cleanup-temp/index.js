// cleanup-temp
// Controlled cleanup of abandoned temporary uploads and expired rate-limit rows.
// Intended to be invoked by a scheduler (see README) with the x-cleanup-secret header.

import { preflight, json, readJson } from '../_shared/http.js';
import { serviceClient } from '../_shared/supabase.js';
import { publicError } from '../_shared/errors.js';

const BUCKET = 'product-uploads';

function fail(mapped) {
  return json(mapped.body, mapped.status);
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(publicError('method_not_allowed'));

  const secret = Deno.env.get('CLEANUP_SECRET');
  if (!secret) {
    return json({ error: { code: 'not_configured', message: 'CLEANUP_SECRET is not configured.' } }, 503);
  }
  const provided = req.headers.get('x-cleanup-secret') || '';
  if (!timingSafeEqual(provided, secret)) {
    return fail(publicError('forbidden'));
  }

  let admin;
  try {
    admin = serviceClient();
  } catch {
    return fail(publicError('missing_env'));
  }

  try {
    const { value } = await readJson(req, 4 * 1024).catch(() => ({ value: null }));
    const olderThanHours = Math.min(Math.max(Number(value?.olderThanHours || 48), 1), 720);
    const cutoff = Date.now() - olderThanHours * 3600 * 1000;

    const paths = [];
    let scannedFolders = 0;

    const { data: rootEntries, error: rootError } = await admin.storage.from(BUCKET).list('temp', {
      limit: 1000,
    });
    if (rootError) throw rootError;

    for (const entry of Array.isArray(rootEntries) ? rootEntries : []) {
      const nestedPath = `temp/${entry.name}`;
      const { data: nested, error: nestedError } = await admin.storage.from(BUCKET).list(nestedPath, {
        limit: 1000,
      });
      if (nestedError) continue;
      scannedFolders += 1;
      for (const file of Array.isArray(nested) ? nested : []) {
        const created = file?.created_at || file?.metadata?.created_at;
        if (!created) continue;
        const createdMs = Date.parse(created);
        if (Number.isNaN(createdMs)) continue;
        if (createdMs < cutoff) paths.push(`${nestedPath}/${file.name}`);
      }
    }

    let removed = 0;
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      const { error: removeError } = await admin.storage.from(BUCKET).remove(chunk);
      if (removeError) {
        console.error('cleanup remove failed', removeError);
      } else {
        removed += chunk.length;
      }
    }

    let rateLimitRows = 0;
    try {
      const { data: stale } = await admin
        .from('rate_limits')
        .delete({ count: 'exact' })
        .lt('window_start', new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString())
        .select('bucket');
      rateLimitRows = Array.isArray(stale) ? stale.length : 0;
    } catch (error) {
      console.error('rate limit cleanup failed', error);
    }

    return json({ ok: true, scannedFolders, removed, rateLimitRows, olderThanHours });
  } catch (error) {
    console.error('cleanup-temp failed', error);
    return fail(publicError('server_error', 500, 'Something went wrong. Please try again.'));
  }
});
