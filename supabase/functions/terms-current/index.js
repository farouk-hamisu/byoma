// terms-current
// Returns metadata for the currently published Terms & Conditions PDF and, on request,
// a short-lived signed URL for viewing it. Anonymous applicants use this endpoint only.

import { preflight, json, clientIp } from '../_shared/http.js';
import { serviceClient } from '../_shared/supabase.js';
import { publicError, isRateLimited, rateLimited } from '../_shared/errors.js';

function fail(mapped) {
  return json(mapped.body, mapped.status);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'POST') return fail(publicError('method_not_allowed'));

  let admin;
  try {
    admin = serviceClient();
  } catch {
    return fail(publicError('missing_env'));
  }

  try {
    const ip = clientIp(req);
    try {
      await admin.rpc('bump_rate_limit', {
        p_bucket: 'terms_current',
        p_key: ip || 'unknown',
        p_window_seconds: 600,
        p_max: 180,
      });
    } catch (error) {
      if (isRateLimited(error)) return fail(rateLimited());
      console.error('rate limit check failed', error);
      return fail(publicError('service_unavailable'));
    }

    const search = new URL(req.url).searchParams;
    let wantsUrl = search.get('withUrl') === '1';
    if (req.method === 'POST') {
      let raw = '';
      try {
        raw = await req.text();
      } catch {
        return fail(publicError('invalid_json'));
      }
      if (raw.length > 1024) return fail(publicError('invalid_payload'));
      try {
        const body = raw ? JSON.parse(raw) : {};
        wantsUrl = wantsUrl || body?.withUrl === true;
      } catch {
        return fail(publicError('invalid_json'));
      }
    }

    const { data, error } = await admin
      .from('terms_documents')
      .select('id, title, description, version, sha256, file_size, published_at, storage_path')
      .eq('status', 'published')
      .eq('is_current', true)
      .maybeSingle();

    if (error) {
      console.error('terms lookup failed', error);
      return fail(publicError('service_unavailable'));
    }
    if (!data) {
      return json({ available: false });
    }

    const base = {
      available: true,
      id: data.id,
      title: data.title,
      description: data.description || '',
      version: data.version,
      sha256: data.sha256 || null,
      fileSize: Number(data.file_size || 0),
      publishedAt: data.published_at,
    };

    if (wantsUrl) {
      const { data: signed, error: signError } = await admin.storage
        .from('terms-docs')
        .createSignedUrl(data.storage_path, 3600);
      if (signError || !signed?.signedUrl) {
        console.error('terms signed url failed', signError);
        return fail(publicError('service_unavailable'));
      }
      base.url = signed.signedUrl;
      base.urlExpiresInSeconds = 3600;
    }

    return json(base);
  } catch (error) {
    console.error('terms-current failed', error);
    return fail(publicError('server_error', 500, 'Something went wrong. Please try again.'));
  }
});
