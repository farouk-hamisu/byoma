// Validation utilities — intentionally permissive for international input
// while still rejecting malformed or unsafe values.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_ALLOWED_RE = /^[+\d\s().\-–—]+$/;
const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

export function validateEmail(value) {
  const email = String(value || '').trim();
  if (isEmpty(email)) return 'Please enter your email address.';
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'Please enter a valid email address.';
  return null;
}

// Accepts a broad range of international formats: +44 20 7946 0958, (020) 7946 0958, 07700 900123…
export function validatePhone(value) {
  const phone = String(value || '').trim();
  if (isEmpty(phone)) return 'Please enter your phone number.';
  if (phone.length > 40 || !PHONE_ALLOWED_RE.test(phone)) {
    return 'Please enter a valid phone number.';
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 15) {
    return 'Phone numbers must contain between 5 and 15 digits.';
  }
  return null;
}

// Only http(s), no embedded credentials, no whitespace.
export function validateUrl(value, { required = false } = {}) {
  const raw = String(value || '').trim();
  if (isEmpty(raw)) return required ? 'Please enter a URL.' : null;
  if (raw.length > 2000) return 'This URL is too long.';
  if (/\s/.test(raw)) return 'URLs cannot contain spaces.';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Please enter a complete URL, including https://';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http:// and https:// links are allowed.';
  }
  if (parsed.username || parsed.password) {
    return 'URLs with embedded credentials are not allowed.';
  }
  return null;
}

export function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

export function validateHandle(value, { required = false } = {}) {
  const handle = normalizeHandle(value);
  if (isEmpty(handle)) return required ? 'Please enter this handle.' : null;
  if (!HANDLE_RE.test(handle)) {
    return 'Use letters, numbers, dots, dashes or underscores (with or without @).';
  }
  return null;
}

export function requiredRule(label = 'This field') {
  return (value) => (isEmpty(value) ? `${label} is required.` : null);
}

export function maxLengthRule(max, label = 'This value') {
  return (value) => (String(value || '').length > max ? `${label} must be ${max} characters or fewer.` : null);
}

export function runRules(value, rules) {
  for (const rule of rules) {
    if (typeof rule !== 'function') continue;
    const error = rule(value);
    if (error) return error;
  }
  return null;
}

// A complete per-field validator registry used by both the wizard and review step.
export const FIELD_VALIDATORS = {
  email: (value) => validateEmail(value),
  phone: (value) => validatePhone(value),
  url: (value) => validateUrl(value, { required: false }),
  portfolio_url: (value) => validateUrl(value, { required: false }),
  instagram_handle: (value) => validateHandle(value, { required: true }),
  tiktok_handle: (value) => validateHandle(value, { required: true }),
};
