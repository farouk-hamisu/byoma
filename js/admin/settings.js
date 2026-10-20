// Settings page: load current settings + preferences, save via admin RPCs.

import { $ } from '../utils/dom.js';
import { toast } from '../utils/toast.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import { getSettings, saveSettings, getPreferences, savePreferences } from './api.js';

const TEXT_FIELDS = [
  'brand_name', 'logo_url', 'welcome_eyebrow', 'welcome_heading', 'welcome_description',
  'welcome_button_label', 'applications_paused_message', 'application_instructions',
  'footer_text', 'contact_email', 'privacy_policy_url', 'estimated_time',
];
const COLOR_FIELDS = ['primary_color', 'secondary_color', 'background_color'];
const NUMBER_SETTINGS = ['min_products', 'max_products'];
const BOOL_SETTINGS = ['product_image_enabled', 'applications_paused'];

function fill(settings, prefs) {
  for (const key of TEXT_FIELDS) {
    const input = $(`#${key}`);
    if (input) input.value = settings[key] ?? '';
  }
  for (const key of COLOR_FIELDS) {
    const input = $(`#${key}`);
    if (input && settings[key]) input.value = settings[key];
  }
  for (const key of NUMBER_SETTINGS) {
    const input = $(`#${key}`);
    if (input) input.value = settings[key] ?? '';
  }
  for (const key of BOOL_SETTINGS) {
    const input = $(`#${key}`);
    if (input) input.checked = Boolean(settings[key]);
  }
  const font = $('#font_selection');
  if (font) font.value = settings.font_selection || 'editorial';

  if (prefs) {
    $('#max_upload_mb').value = prefs.max_upload_mb ?? 8;
    const types = prefs.accepted_image_types || [];
    $('#type_jpeg').checked = types.includes('image/jpeg');
    $('#type_png').checked = types.includes('image/png');
    $('#type_webp').checked = types.includes('image/webp');
    $('#notify_applicant_confirmation').checked = Boolean(prefs.notify_applicant_confirmation);
    $('#admin_notification_email').value = prefs.admin_notification_email || '';
    $('#notify_admin_on_submission').checked = Boolean(prefs.notify_admin_on_submission);
  }
}

function collect() {
  const settingsPatch = {};
  for (const key of TEXT_FIELDS) {
    const input = $(`#${key}`);
    if (input) settingsPatch[key] = input.value.trim();
  }
  for (const key of COLOR_FIELDS) {
    const input = $(`#${key}`);
    if (input) settingsPatch[key] = input.value;
  }
  const font = $('#font_selection');
  if (font) settingsPatch.font_selection = font.value;
  for (const key of NUMBER_SETTINGS) {
    const input = $(`#${key}`);
    if (input) settingsPatch[key] = Number(input.value);
  }
  for (const key of BOOL_SETTINGS) {
    const input = $(`#${key}`);
    if (input) settingsPatch[key] = Boolean(input.checked);
  }

  const types = [];
  if ($('#type_jpeg').checked) types.push('image/jpeg');
  if ($('#type_png').checked) types.push('image/png');
  if ($('#type_webp').checked) types.push('image/webp');

  const prefsPatch = {
    max_upload_mb: Number($('#max_upload_mb').value) || 8,
    accepted_image_types: types,
    notify_applicant_confirmation: $('#notify_applicant_confirmation').checked,
    admin_notification_email: $('#admin_notification_email').value.trim(),
    notify_admin_on_submission: $('#notify_admin_on_submission').checked,
  };
  return { settingsPatch, prefsPatch };
}

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Settings' });
  renderMobileToggle();

  const [settings, prefs] = await Promise.all([getSettings(), getPreferences()]);
  fill(settings, prefs);

  $('[data-settings-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = $('[data-save]');
    saveButton.disabled = true;
    const errorBox = $('[data-error]');
    const savedBox = $('[data-saved]');
    errorBox.hidden = true;
    savedBox.hidden = true;

    const { settingsPatch, prefsPatch } = collect();
    if (Number(settingsPatch.min_products) > Number(settingsPatch.max_products)) {
      errorBox.textContent = 'Minimum products cannot exceed maximum products.';
      errorBox.hidden = false;
      saveButton.disabled = false;
      return;
    }
    if (!prefsPatch.accepted_image_types.length) {
      errorBox.textContent = 'Select at least one accepted image type.';
      errorBox.hidden = false;
      saveButton.disabled = false;
      return;
    }

    try {
      await Promise.all([saveSettings(settingsPatch), savePreferences(prefsPatch)]);
      savedBox.hidden = false;
      toast('Settings saved.', { type: 'success' });
      setTimeout(() => { savedBox.hidden = true; }, 4000);
    } catch (error) {
      errorBox.textContent = error?.message || 'Could not save settings.';
      errorBox.hidden = false;
      toast(error?.message || 'Save failed.', { type: 'error' });
    } finally {
      saveButton.disabled = false;
    }
  });
}

boot();
