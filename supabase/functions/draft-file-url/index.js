// draft-file-url
// Returns short-lived signed URLs for the temp uploads belonging to one applicant's draft
// token, so image previews survive a page refresh without exposing storage publicly.

import { preflight, json, clientIp, readJson } from '../_shared/http.js';
import { serviceClient } from '../_shared/supabase.js';
import { publicError, isRateLimited, rateLimited } from '../_shared/errors.js';

const TOKEN_RE = /^[a-f0-9-]{16,64}$/;
const MAX_FILES = 40;

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
        p_bucket: 'draft_file_url',
        p_key: ip || 'unknown',
        p_window_seconds: 600,
        p_max: 40,
      });
    } catch (error) {
      if (isRateLimited(error)) return fail(rateLimited());
      console.error('rate limit check failed', error);
      return fail(publicError('service_unavailable'));
    }

    const { value, error: readError } = await readJson(req, 4 * 1024);
    if (readError) return fail(publicError(readError));

    const token = String(value?.uploadToken || '').toLowerCase();
    if (!TOKEN_RE.test(token)) return fail(publicError('invalid_payload'));

    const { data: files, error } = await admin.storage.from('product-uploads').list(`temp/${token}`, {
      limit: MAX_FILES,
      sortBy: { column: 'created_at', order: 'asc' },
    });
    if (error) {
      console.error('draft listing failed', error);
      return fail(publicError('service_unavailable'));
    }

    const result = [];
    for (const file of Array.isArray(files) ? files : []) {
      const path = `temp/${token}/${file.name}`;
      const { data: signed } = await admin.storage.from('product-uploads').createSignedUrl(path, 3600);
      if (signed?.signedUrl) {
        result.push({
          path,
          url: signed.signedUrl,
          size: Number(file?.metadata?.size || 0),
          createdAt: file?.created_at || null,
        });
      }
    }

    return json({ files: result, expiresIn: 3600 });
  } catch (error) {
    console.error('draft-file-url failed', error);
    return fail(publicError('server_error', 500, 'Something went wrong. Please try again.'));
  }
});
