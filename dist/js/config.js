// Public runtime configuration. Values come from /env.js (generated from environment
// variables — see scripts/generate-env.js). Only public-safe values live here.

export function getConfig() {
  const raw = globalThis.__APP_CONFIG__ || {};
  return {
    supabaseUrl: String(raw.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: String(raw.SUPABASE_ANON_KEY || '').trim(),
    appOrigin: String(raw.APP_ORIGIN || '').trim().replace(/\/+$/, ''),
    // Same-origin path that proxies to the Supabase project (see /api/supabase
    // rewrite in vercel.json and scripts/serve.js). Empty string disables it.
    supabaseProxyPath: String(raw.SUPABASE_PROXY_PATH ?? '/api/supabase').trim(),
  };
}

export function isConfigured(config = getConfig()) {
  if (!/^https?:\/\//.test(config.supabaseUrl)) return false;
  if (/YOUR_PROJECT/i.test(config.supabaseUrl)) return false;
  if (!config.supabaseAnonKey || /^YOUR_/i.test(config.supabaseAnonKey)) return false;
  return true;
}

export const CONFIG_ERROR_MESSAGE =
  'This site is missing its configuration. Ask the site owner to run `npm run env` and publish the generated env.js file.';
