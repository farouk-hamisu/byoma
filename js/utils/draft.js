// Draft persistence without an applicant account.
//
// sessionStorage holds the complete draft (including delivery details) so a refresh in the
// same tab never loses work. localStorage keeps a reduced copy — social details and product
// entries only — so a browser restart can recover the majority of an application without
// persisting sensitive delivery information beyond the session.

import { clearImages } from './idb.js';

const FULL_KEY = 'partnershipy.draft.v1';
const LIGHT_KEY = 'partnershipy.draft-light.v1';

const SENSITIVE_FIELDS = new Set([
  'full_name',
  'email',
  'phone',
  'country',
  'region',
  'address_street',
  'address_line2',
  'address_city',
  'address_region',
  'address_postal_code',
  'address_country',
]);

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function serializeProducts(products) {
  return (products || []).map((product) => ({
    localId: product.localId,
    name: product.name || '',
    url: product.url || '',
    variant: product.variant || '',
    notes: product.notes || '',
    files: (product.files || []).map((file) => ({
      localId: file.localId,
      path: file.path || '',
      mime: file.mime || '',
      size: Number(file.size) || 0,
      sha256: file.sha256 || '',
      originalName: file.originalName || '',
      status: file.status === 'ready' ? 'ready' : file.status,
      error: file.error || '',
    })),
  }));
}

export function buildSnapshot(state) {
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    step: Number(state.step) || 1,
    uploadToken: state.uploadToken || '',
    idempotencyKey: state.idempotencyKey || '',
    fields: { ...(state.fields || {}) },
    otherHandles: (state.otherHandles || []).map((item) => ({ ...item })),
    products: serializeProducts(state.products),
    consent: {
      checked: Boolean(state.consent?.checked),
      reviewedVersion: state.consent?.reviewedVersion || null,
      openedAt: state.consent?.openedAt || null,
      documentId: state.consent?.documentId || null,
    },
  };
}

export function saveDraft(state) {
  const snapshot = buildSnapshot(state);
  safeSet(window.sessionStorage, FULL_KEY, JSON.stringify(snapshot));

  const lightFields = {};
  for (const [key, value] of Object.entries(snapshot.fields)) {
    if (!SENSITIVE_FIELDS.has(key)) lightFields[key] = value;
  }
  safeSet(
    window.localStorage,
    LIGHT_KEY,
    JSON.stringify({
      ...snapshot,
      fields: lightFields,
      // consent must be re-confirmed explicitly in a new session
      consent: { checked: false, reviewedVersion: null, openedAt: null, documentId: null },
    }),
  );
  return snapshot;
}

export function loadDraft() {
  const rawFull = safeGet(window.sessionStorage, FULL_KEY);
  if (rawFull) {
    try {
      const draft = JSON.parse(rawFull);
      if (draft && draft.v === 1) return { mode: 'full', draft };
    } catch {
      safeRemove(window.sessionStorage, FULL_KEY);
    }
  }

  const rawLight = safeGet(window.localStorage, LIGHT_KEY);
  if (rawLight) {
    try {
      const draft = JSON.parse(rawLight);
      if (draft && draft.v === 1) return { mode: 'light', draft };
    } catch {
      safeRemove(window.localStorage, LIGHT_KEY);
    }
  }
  return { mode: null, draft: null };
}

export function clearDraft() {
  safeRemove(window.sessionStorage, FULL_KEY);
  safeRemove(window.localStorage, LIGHT_KEY);
  return clearImages();
}

export function hasStoredDraft() {
  return Boolean(
    safeGet(window.sessionStorage, FULL_KEY) || safeGet(window.localStorage, LIGHT_KEY),
  );
}
