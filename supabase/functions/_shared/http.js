// Shared HTTP helpers for Supabase Edge Functions.

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cleanup-secret, x-application-name, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function preflight(req) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS, status: 200 });
  }
  return null;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

export function clientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || '';
}

export async function readJson(req, maxBytes = 400 * 1024) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    return { error: 'payload_too_large' };
  }
  let text;
  try {
    text = await req.text();
  } catch {
    return { error: 'invalid_json' };
  }
  if (text.length > maxBytes) {
    return { error: 'payload_too_large' };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'invalid_json' };
  }
}
