// prepare-upload
// Issues a short-lived signed upload URL for a temp product screenshot. Validates the declared
// content type against administrator configuration and rate limits callers by IP.

import { preflight, json, clientIp, readJson } from '../_shared/http.js';
import { serviceClient } from '../_shared/supabase.js';
import { publicError, isRateLimited, rateLimited } from '../_shared/errors.js';

const TOKEN_RE = /^[a-f0-9-]{16,64}$/;
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const DEFAULT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function fail(mapped) {
  return json(mapped.body, mapped.status);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(publicError('method_not_allowed'));

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
        p_bucket: 'prepare_upload',
        p_key: ip || 'unknown',
        p_window_seconds: 600,
        p_max: 150,
      });
    } catch (error) {
      if (isRateLimited(error)) return fail(rateLimited());
      console.error('rate limit check failed', error);
      return fail(publicError('service_unavailable'));
    }

    const { value, error: readError } = await readJson(req, 8 * 1024);
    if (readError) return fail(publicError(readError));

    const contentType = String(value?.contentType || '').toLowerCase();
    const { data: prefs } = await admin
      .from('admin_preferences')
      .select('accepted_image_types, max_upload_mb')
      .eq('id', true)
      .maybeSingle();

    const accepted = Array.isArray(prefs?.accepted_image_types) && prefs.accepted_image_types.length
      ? prefs.accepted_image_types
      : DEFAULT_TYPES;

    if (!accepted.includes(contentType) || !EXTENSIONS[contentType]) {
      return fail(publicError('invalid_file_type'));
    }

    let token = String(value?.uploadToken || '').toLowerCase();
    if (token) {
      if (!TOKEN_RE.test(token)) return fail(publicError('invalid_payload'));
    } else {
      token = crypto.randomUUID();
    }

    const path = `temp/${token}/${crypto.randomUUID()}.${EXTENSIONS[contentType]}`;

    const { data, error } = await admin.storage.from('product-uploads').createSignedUploadUrl(path);
    if (error) {
      console.error('createSignedUploadUrl failed', error);
      return fail(publicError('upload_failed'));
    }

    return json({
      uploadToken: token,
      path,
      token: data.token,
      signedUrl: data.signedUrl,
      acceptedTypes: accepted,
      maxBytes: (Number(prefs?.max_upload_mb) || 8) * 1024 * 1024,
      expiresIn: 3600,
    });
  } catch (error) {
    console.error('prepare-upload failed', error);
    return fail(publicError('server_error', 500, 'Something went wrong. Please try again.'));
  }
});
