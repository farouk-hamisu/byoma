// Welcome page: branding, copy, paused state, resume prompt, terms link.

import { $, $$ } from '../utils/dom.js';
import { toast } from '../utils/toast.js';
import { hasStoredDraft, clearDraft } from '../utils/draft.js';
import { loadPublicSettings } from './api.js';
import { applyBranding, pageTitle } from './branding.js';
import { openTermsViewer } from './terms-viewer.js';
import { showLoader, NAV_FLAG } from './page-loader.js';

const COPY_KEYS = [
  'welcome_eyebrow',
  'welcome_heading',
  'welcome_description',
  'applications_paused_message',
  'welcome_button_label',
];

function applyCopy(settings) {
  for (const key of COPY_KEYS) {
    const value = settings[key];
    if (!value) continue;
    $$(`[data-copy="${key}"]`).forEach((node) => {
      node.textContent = value;
    });
  }
  if (settings.estimated_time) {
    const meta = $('[data-estimated-time]');
    if (meta) meta.textContent = `${settings.estimated_time} · No account required`;
  }
}

function applyInstructions(settings) {
  const section = $('[data-how]');
  const wrap = $('[data-instructions]');
  const text = $('[data-instructions-text]');
  if (!section) return;
  if (settings.application_instructions && text) {
    text.textContent = settings.application_instructions;
    wrap.hidden = false;
  }
  section.hidden = false;
}

function applyPausedState(settings) {
  const paused = Boolean(settings.applications_paused);
  $$('[data-start-button]').forEach((button) => {
    if (paused) {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('role', 'link');
      button.tabIndex = 0;
      button.addEventListener('click', blockStart, true);
    } else {
      button.removeAttribute('aria-disabled');
      button.removeEventListener('click', blockStart, true);
    }
  });
}

function blockStart(event) {
  event.preventDefault();
  event.stopPropagation();
  toast('Applications are currently closed. Please check back soon.', { type: 'warning' });
}

function bindTermsLink() {
  $$('[data-terms-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openTermsViewer({ title: 'Terms & Conditions' }).then((result) => {
        if (!result.opened && !result.document) {
          toast('The Terms document could not be loaded. Please try again.', { type: 'error' });
        }
      });
    });
  });
}

function bindResumeCard() {
  const card = $('[data-resume-card]');
  if (!card || !hasStoredDraft()) return;
  card.hidden = false;
  const discard = $('[data-discard-draft]');
  discard?.addEventListener('click', async () => {
    await clearDraft();
    card.hidden = true;
    toast('Saved draft discarded.', { type: 'default' });
  });
}

function bindStartButtons() {
  $$('[data-start-button]').forEach((button) => {
    button.addEventListener('click', (event) => {
      if (button.getAttribute('aria-disabled') === 'true') return; // paused — blockStart handles it
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; // let modified clicks behave normally
      const href = button.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      try {
        sessionStorage.setItem(NAV_FLAG, '1');
      } catch {
        /* storage unavailable — loader still shows for this page */
      }
      showLoader('Loading application…');
      // One frame so the overlay paints before navigation starts.
      requestAnimationFrame(() => {
        window.location.href = href;
      });
    });
  });
}

function showBootError(message) {
  const section = $('[data-boot-error]');
  const msg = $('[data-boot-error-message]');
  if (msg) msg.textContent = message;
  if (section) section.hidden = false;
  $('[data-hero]')?.setAttribute('hidden', '');
  $('[data-resume-card]')?.setAttribute('hidden', '');
  $('[data-how]')?.setAttribute('hidden', '');
}

async function boot() {
  try {
    const { settings } = await loadPublicSettings();
    applyBranding(settings);
    pageTitle('', settings);
    applyCopy(settings);
    applyInstructions(settings);
    applyPausedState(settings);
    bindTermsLink();
    bindResumeCard();

    $('[data-hero]').hidden = false;
  } catch (error) {
    console.error('welcome boot failed', error);
    if (String(error?.code || '').includes('missing_env')) {
      showBootError('The site is not configured yet. Run "npm run env" to create your environment file.');
    } else {
      showBootError('We could not load the application right now. Please try again in a moment.');
    }
  }
}

$('[data-retry-boot]')?.addEventListener('click', () => {
  $('[data-boot-error]').hidden = true;
  boot();
});

bindStartButtons();
boot();
