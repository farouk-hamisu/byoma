// Applies administrator-managed branding to every public page.
// The official Fortuna Skin logo (public/furtunaskin.jpg) is the platform mark and
// is used consistently; administrators can still tune colours, fonts and copy.

export const OFFICIAL_LOGO = '/public/furtunaskin.jpg';
const DEFAULT_BRAND = 'Fortuna Skin';

function luminance(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return 0;
  const channels = [0, 2, 4].map((index) => {
    const raw = parseInt(value.slice(index, index + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastText(hex) {
  return luminance(hex) > 0.45 ? '#101110' : '#ffffff';
}

export function applyBranding(settings = {}) {
  const root = document.documentElement;

  if (settings.primary_color) {
    root.style.setProperty('--color-primary', settings.primary_color);
    root.style.setProperty('--color-primary-contrast', contrastText(settings.primary_color));
  }
  if (settings.secondary_color) root.style.setProperty('--color-secondary', settings.secondary_color);
  if (settings.background_color) root.style.setProperty('--color-bg', settings.background_color);
  if (settings.font_selection) root.dataset.font = settings.font_selection;

  const brandName = settings.brand_name || DEFAULT_BRAND;
  document.querySelectorAll('[data-brand-name]').forEach((node) => {
    node.textContent = brandName;
  });

  document.querySelectorAll('[data-brand-logo]').forEach((node) => {
    node.src = OFFICIAL_LOGO;
    node.alt = `${brandName}`;
    node.hidden = false;
    node.addEventListener('error', () => {
      node.hidden = true;
    }, { once: true });
  });

  document.querySelectorAll('[data-footer-text]').forEach((node) => {
    node.textContent = settings.footer_text || `© ${new Date().getFullYear()} ${brandName}`;
  });

  const privacyUrl = settings.privacy_policy_url || '/privacy.html';
  document.querySelectorAll('[data-privacy-link]').forEach((node) => {
    node.href = privacyUrl;
    if (privacyUrl.startsWith('http')) {
      node.rel = 'noopener noreferrer';
      node.target = '_blank';
    }
  });

  document.querySelectorAll('[data-contact-email]').forEach((node) => {
    const email = settings.contact_email || '';
    if (email) {
      node.href = `mailto:${email}`;
      node.textContent = node.dataset.contactLabel || email;
      node.hidden = false;
    } else {
      node.hidden = true;
    }
  });

  document.body.dataset.applicationsPaused = settings.applications_paused ? 'true' : 'false';

  return settings;
}

export function pageTitle(title, settings = {}) {
  const brand = settings.brand_name || DEFAULT_BRAND;
  document.title = title ? `${title} · ${brand}` : brand;
}
