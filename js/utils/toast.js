// Toast notifications + an aria-live announcer for screen readers.

let region = null;

function ensureRegion() {
  if (region && document.body.contains(region)) return region;
  region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'false');
    document.body.append(region);
  }
  return region;
}

export function announce(message) {
  const live = ensureRegion();
  const text = document.createElement('span');
  text.className = 'visually-hidden';
  text.textContent = message;
  live.append(text);
  setTimeout(() => text.remove(), 1500);
}

export function toast(message, { type = 'default', timeout = 5000 } = {}) {
  const live = ensureRegion();
  const node = document.createElement('div');
  node.className = `toast${type ? ` toast--${type}` : ''}`;

  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', () => node.remove());
  node.append(close);

  live.append(node);
  if (timeout > 0) setTimeout(() => node.remove(), timeout);
  return node;
}

export function clearToasts() {
  const live = ensureRegion();
  live.querySelectorAll('.toast').forEach((node) => node.remove());
}
