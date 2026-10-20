// Minimal full-screen loading overlay used during page transitions and form
// submissions. Counter-based so overlapping show/hide calls stay balanced.
// Enforces a minimum on-screen time so the spinner stays perceptible on fast
// connections where the operation completes before a frame would even paint.

const NAV_FLAG = 'fs-nav-loading';
const MIN_VISIBLE_MS = 400;
let overlay = null;
let depth = 0;
let shownAt = 0;
let hideTimer = null;

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
  text.textContent = 'Loading application…';
  box.append(spinner, text);
  overlay.append(box);
  document.body.append(overlay);
  document.body.classList.add('page-loader-open');
  shownAt = performance.now();
  setMessage(message);
  return overlay;
}

function setMessage(message) {
  const text = overlay?.querySelector('.page-loader__message');
  if (text && message) text.textContent = message;
}

export function showLoader(message = 'Loading application…') {
  clearTimeout(hideTimer);
  depth += 1;
  ensureOverlay(message);
}

export function hideLoader() {
  depth = Math.max(0, depth - 1);
  if (depth > 0 || !overlay) return;
  const finish = () => {
    const node = overlay;
    if (!node) return;
    overlay = null;
    node.classList.add('is-hiding');
    document.body.classList.remove('page-loader-open');
    setTimeout(() => node.remove(), 250);
  };
  const wait = MIN_VISIBLE_MS - (performance.now() - shownAt);
  if (wait > 0) hideTimer = setTimeout(finish, wait);
  else finish();
}

export function isLoading() {
  return depth > 0;
}

export { NAV_FLAG };
