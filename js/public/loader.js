// Minimal full-screen loading overlay used during page transitions and form
// submissions. Counter-based so overlapping show/hide calls stay balanced.

const NAV_FLAG = 'fs-nav-loading';
let overlay = null;
let depth = 0;

function ensureOverlay(message) {
  if (overlay && document.body.contains(overlay)) {
    setMessage(message);
    return overlay;
  }
  overlay = document.createElement('div');
  overlay.className = 'page-loader';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  const box = document.createElement('div');
  box.className = 'page-loader__box';
  const spinner = document.createElement('span');
  spinner.className = 'page-loader__spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'page-loader__message';
  text.textContent = 'Loading…';
  box.append(spinner, text);
  overlay.append(box);
  document.body.append(overlay);
  document.body.classList.add('page-loader-open');
  setMessage(message);
  return overlay;
}

function setMessage(message) {
  const text = overlay?.querySelector('.page-loader__message');
  if (text && message) text.textContent = message;
}

export function showLoader(message = 'Loading…') {
  depth += 1;
  ensureOverlay(message);
}

export function hideLoader() {
  depth = Math.max(0, depth - 1);
  if (depth > 0 || !overlay) return;
  const node = overlay;
  overlay = null;
  node.classList.add('is-hiding');
  document.body.classList.remove('page-loader-open');
  setTimeout(() => node.remove(), 250);
}

export function isLoading() {
  return depth > 0;
}

export { NAV_FLAG };
