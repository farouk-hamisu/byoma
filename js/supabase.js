// Supabase browser client (anon key only — no privileged credentials ever reach the client)
// and a small wrapper for Edge Function invocation with friendly error handling.
//
// Connectivity: all requests prefer a same-origin proxy (/api/supabase/* — see the
// rewrite in vercel.json and scripts/serve.js) so the browser never talks to
// *.supabase.co directly. That sidesteps extension/DNS/network blocks and any
// gateway CORS issue. A probe decides proxy vs direct before the client is
// created (cached for the session so each navigation doesn't repeat it); if the
// proxy is unavailable the client falls back to the project URL. The Supabase
// SDK itself is injected by this module — no parser-blocking tag in the page
// head — so it downloads while the page is already parsing and painting.

import { getConfig, isConfigured, CONFIG_ERROR_MESSAGE } from './config.js';

const SDK_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.min.js';
const CONNECTION_CACHE_KEY = 'partnershipy.connection.v1';
const SDK_TIMEOUT_MS = 15000;

let client = null;
let connectionPromise = null;
let resolvedBaseUrl = null;
let sdkPromise = null;

export class EdgeError extends Error {
  constructor({ code, message, status, retryable }) {
    super(message || 'Something went wrong. Please try again.');
    this.name = 'EdgeError';
    this.code = code || 'server_error';
    this.status = status || 500;
    this.retryable = retryable !== false && this.status >= 500;
  }
}

// The Supabase SDK is loaded on demand instead of through a parser-blocking
// <script> in every page head: the page can paint immediately and the SDK
// download runs in parallel with the connection probe below.
function loadSdk() {
  if (globalThis.supabase?.createClient) return Promise.resolve(null);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(sdkMissingError());
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => settle(reject, sdkMissingError()), SDK_TIMEOUT_MS);
    script.onload = () => {
      if (globalThis.supabase?.createClient) settle(resolve, null);
      else settle(reject, sdkMissingError());
    };
    script.onerror = () => settle(reject, sdkMissingError());
    document.head.append(script);
  });
  // Cache the outcome (including failures) so a broken CDN never queues up
  // duplicate script tags — recovery is a page refresh.
  return sdkPromise;
}

function sdkMissingError() {
  return new EdgeError({
    code: 'sdk_missing',
    message: 'The application failed to load its networking library. Please refresh the page.',
    status: 0,
    retryable: false,
  });
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

// The proxy-vs-direct decision is remembered for the session: navigating from
// the home page to the application form must not repeat the probe round-trip.
function readConnectionCache() {
  try {
    const raw = globalThis.sessionStorage?.getItem(CONNECTION_CACHE_KEY);
    return raw === 'proxy' || raw === 'direct' ? raw : null;
  } catch {
    return null;
  }
}

function writeConnectionCache(mode) {
  try {
    globalThis.sessionStorage?.setItem(CONNECTION_CACHE_KEY, mode);
  } catch {
    /* storage unavailable — the probe simply runs again */
  }
}

async function chooseBaseUrl() {
  const config = getConfig();
  if (!isConfigured(config)) return config.supabaseUrl;
  const proxy = proxyBaseFor(config);
  if (!proxy) return config.supabaseUrl;

  const cached = readConnectionCache();
  if (cached === 'proxy') return proxy;
  if (cached === 'direct') return config.supabaseUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // Same-origin request — no CORS involved. A JSON reply (any status but 404)
    // proves the proxy rewrite is in place; HTML means a static host without it.
    const response = await fetch(`${proxy}/rest/v1/`, {
      headers: { apikey: config.supabaseAnonKey },
      signal: controller.signal,
    });
    if (response.headers.get('x-supabase-proxy') === '1') {
      writeConnectionCache('proxy');
      return proxy;
    }
    const type = response.headers.get('content-type') || '';
    const mode = type.includes('json') && response.status !== 404 ? 'proxy' : 'direct';
    writeConnectionCache(mode);
    return mode === 'proxy' ? proxy : config.supabaseUrl;
  } catch {
    writeConnectionCache('direct');
    return config.supabaseUrl;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves which base URL to use (memoised). Every entry point may await this,
// though the module top-level await already guarantees it before first use.
// The SDK download runs alongside the probe so neither serialises the other.
// A failed SDK download is intentionally not thrown here — getClient() reports
// it, so callers keep their own error handling (and the module still evaluates).
export function ensureConnection() {
  if (!connectionPromise) {
    connectionPromise = Promise.all([
      chooseBaseUrl().catch(() => getConfig().supabaseUrl),
      loadSdk().catch(() => null),
    ]).then(([base]) => {
      resolvedBaseUrl = base;
      return base;
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
