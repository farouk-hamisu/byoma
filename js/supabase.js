// Supabase browser client (anon key only — no privileged credentials ever reach the client)
// and a small wrapper for Edge Function invocation with friendly error handling.
//
// Connectivity: all requests prefer a same-origin proxy (/api/supabase/* — see the
// rewrite in vercel.json and scripts/serve.js) so the browser never talks to
// *.supabase.co directly. That sidesteps extension/DNS/network blocks and any
// gateway CORS issue. A one-time probe decides proxy vs direct before the client
// is created; if the proxy is unavailable the client falls back to the project URL.

import { getConfig, isConfigured, CONFIG_ERROR_MESSAGE } from './config.js';

let client = null;
let connectionPromise = null;
let resolvedBaseUrl = null;

export class EdgeError extends Error {
  constructor({ code, message, status, retryable }) {
    super(message || 'Something went wrong. Please try again.');
    this.name = 'EdgeError';
    this.code = code || 'server_error';
    this.status = status || 500;
    this.retryable = retryable !== false && this.status >= 500;
  }
}

function proxyBaseFor(config) {
  const location = globalThis.location;
  if (!location || !/^https?:$/.test(location.protocol)) return null;
  const path = config.supabaseProxyPath;
  if (!path) return null;
  try {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin) return null; // same-origin proxy only
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function chooseBaseUrl() {
  const config = getConfig();
  if (!isConfigured(config)) return config.supabaseUrl;
  const proxy = proxyBaseFor(config);
  if (!proxy) return config.supabaseUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Same-origin request — no CORS involved. A JSON reply (any status but 404)
    // proves the proxy rewrite is in place; HTML means a static host without it.
    const response = await fetch(`${proxy}/rest/v1/`, {
      headers: { apikey: config.supabaseAnonKey },
      signal: controller.signal,
    });
    if (response.headers.get('x-supabase-proxy') === '1') return proxy;
    const type = response.headers.get('content-type') || '';
    return type.includes('json') && response.status !== 404 ? proxy : config.supabaseUrl;
  } catch {
    return config.supabaseUrl;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves which base URL to use (memoised). Every entry point may await this,
// though the module top-level await already guarantees it before first use.
export function ensureConnection() {
  if (!connectionPromise) {
    connectionPromise = chooseBaseUrl()
      .then((base) => {
        resolvedBaseUrl = base;
        return base;
      })
      .catch(() => {
        resolvedBaseUrl = getConfig().supabaseUrl;
        return resolvedBaseUrl;
      });
  }
  return connectionPromise;
}

// Rewrites an absolute Supabase URL (signed storage URL, etc.) to go through the
// active same-origin proxy when one is in use. Leaves other URLs untouched.
export function proxiedUrl(url) {
  try {
    const config = getConfig();
    const base = resolvedBaseUrl;
    if (!base || base === config.supabaseUrl || !/^https?:\/\//.test(String(url || ''))) return url;
    const target = new URL(url);
    const origin = new URL(config.supabaseUrl);
    if (target.origin !== origin.origin) return url;
    return `${base}${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

export function getClient() {
  if (client) return client;
  const config = getConfig();
  if (!isConfigured(config)) {
    throw new EdgeError({ code: 'not_configured', message: CONFIG_ERROR_MESSAGE, status: 0, retryable: false });
  }
  const factory = globalThis.supabase?.createClient;
  if (typeof factory !== 'function') {
    throw new EdgeError({ code: 'sdk_missing', message: 'The application failed to load its networking library. Please refresh the page.', status: 0 });
  }
  client = factory(resolvedBaseUrl || config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export function isConfiguredClient() {
  return isConfigured(getConfig());
}

// Invokes a Supabase Edge Function and normalises failures into EdgeError.
export async function invokeEdge(name, { method = 'POST', body = null, headers = {} } = {}) {
  const supabase = getClient();
  let result;
  try {
    result = await supabase.functions.invoke(name, {
      method,
      body: body ?? undefined,
      headers,
    });
  } catch (error) {
    throw new EdgeError({
      code: 'network_error',
      message: 'We could not reach the server. Check your connection and try again.',
      status: 0,
    });
  }

  if (result?.error) {
    const response = result.error?.context instanceof Response ? result.error.context : null;
    let payload = null;
    if (response) {
      try {
        payload = await response.clone().json();
      } catch {
        payload = null;
      }
    }
    const errorBody = payload?.error;
    if (errorBody?.code) {
      throw new EdgeError({
        code: errorBody.code,
        message: errorBody.message,
        status: response?.status || 500,
        retryable: false,
      });
    }
    const status = response?.status || 0;
    if (result.error?.name === 'FunctionsRelayError' || status === 0) {
      throw new EdgeError({
        code: 'network_error',
        message: 'We could not reach the server. Check your connection and try again.',
        status: 0,
      });
    }
    if (status === 401 || status === 403) {
      throw new EdgeError({ code: 'forbidden', message: 'You are not authorised to perform this action.', status });
    }
    throw new EdgeError({
      code: 'server_error',
      message: 'Something went wrong. Please try again.',
      status,
    });
  }

  return result?.data ?? null;
}

// Pick the connection mode before any client is created (module top-level await).
export const connectionReady = ensureConnection();
await connectionReady;
