// Official shop destination. The original store is the single source of the
// products applicants select — the platform only links out to it, it never
// hosts or fabricates a product catalogue.

export const OFFICIAL_SHOP_URL = 'https://www.furtunaskin.com/collections/all';

// The column default that shipped with the platform — treated as unset so the
// label the platform is written for ("Visit Shop") is what applicants see.
const LEGACY_SHOP_BUTTON_LABEL = 'Open Official Shop';

// Resolve the shop URL: an administrator-configured shop_url wins when it is a
// valid http(s) URL, otherwise the official shop URL is used.
export function resolveShopUrl(settings) {
  const configured = String(settings?.shop_url || '').trim();
  return /^https?:\/\//i.test(configured) ? configured : OFFICIAL_SHOP_URL;
}

// Label for the shop button: an administrator-configured label wins, otherwise
// "Visit Shop".
export function resolveShopLabel(settings) {
  const label = String(settings?.shop_button_label || '').trim();
  return label && label !== LEGACY_SHOP_BUTTON_LABEL ? label : 'Visit Shop';
}

// Point every shop link inside `root` at the resolved shop URL. External links
// always open in a new tab so applicants keep their in-progress application.
export function applyShopLinks(settings, root = document) {
  const href = resolveShopUrl(settings);
  root.querySelectorAll('[data-shop-link]').forEach((link) => {
    link.setAttribute('href', href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
  return href;
}
