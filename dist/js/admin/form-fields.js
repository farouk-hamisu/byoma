// Form builder: toggle enabled/required per field, reorder within a step, save via RPC.

import { $, el, clearNode } from '../utils/dom.js';
import { toast } from '../utils/toast.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import { getFormFields, saveFormFields } from './api.js';

let original = [];
let working = [];

function clone(list) {
  return list.map((item) => ({ ...item, options: item.options ? JSON.parse(JSON.stringify(item.options)) : item.options }));
}

function renderStep(container, stepNumber) {
  clearNode(container);
  const rows = working.filter((f) => Number(f.step) === stepNumber).sort((a, b) => a.position - b.position);

  rows.forEach((field, index) => {
    const row = el('div', { class: 'field-builder-row', 'data-key': field.field_key });

    const posControls = el('div', { class: 'field-builder-row__pos' });
    const up = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      text: '↑',
      'aria-label': `Move ${field.label} up`,
      disabled: index === 0,
      onClick: () => move(field, -1, stepNumber),
    });
    const down = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      text: '↓',
      'aria-label': `Move ${field.label} down`,
      disabled: index === rows.length - 1,
      onClick: () => move(field, 1, stepNumber),
    });
    posControls.append(up, down);

    const labelWrap = el('div');
    labelWrap.append(el('span', { text: field.label }));
    labelWrap.append(el('div', { class: 'field-builder-row__key', text: field.field_key }));

    const typeTag = el('span', { class: 'badge badge--neutral', text: field.field_type });

    const enabledId = `enabled-${field.field_key}`;
    const enabledLabel = el('label', { class: 'switch', for: enabledId }, [
      el('input', { type: 'checkbox', id: enabledId, checked: Boolean(field.enabled) }),
      el('span', { class: 'visually-hidden', text: `Show ${field.label}` }),
    ]);
    enabledLabel.querySelector('input').addEventListener('change', (event) => {
      field.enabled = event.target.checked;
      if (!field.enabled) {
        // disabled fields must not remain required
        field.required = false;
        const reqInput = row.querySelector(`#required-${field.field_key}`);
        if (reqInput) reqInput.checked = false;
      }
    });

    const requiredId = `required-${field.field_key}`;
    const requiredLabel = el('label', { class: 'switch', for: requiredId }, [
      el('input', {
        type: 'checkbox',
        id: requiredId,
        checked: Boolean(field.required),
        disabled: Boolean(field.locked) ? false : !field.enabled,
      }),
      el('span', { class: 'visually-hidden', text: `Require ${field.label}` }),
    ]);
    requiredLabel.querySelector('input').addEventListener('change', (event) => {
      field.required = event.target.checked;
    });

    const lockNote = field.locked
      ? el('span', { class: 'badge badge--neutral', title: 'This field cannot be removed', text: 'locked' })
      : null;

    row.append(posControls, labelWrap, typeTag, enabledLabel, requiredLabel);
    if (lockNote) row.append(lockNote);
    else row.append(el('span'));
    container.append(row);
  });
}

function move(field, delta, stepNumber) {
  const rows = working
    .filter((f) => Number(f.step) === stepNumber)
    .sort((a, b) => a.position - b.position);
  const index = rows.findIndex((f) => f.field_key === field.field_key);
  const target = index + delta;
  if (target < 0 || target >= rows.length) return;
  [rows[index].position, rows[target].position] = [rows[target].position, rows[index].position];
  renderStep($(`[data-step-${stepNumber}]`), stepNumber);
}

function renderAll() {
  renderStep($('[data-step-1]'), 1);
  renderStep($('[data-step-2]'), 2);
}

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Form builder' });
  renderMobileToggle();

  original = await getFormFields();
  working = clone(original);
  renderAll();

  $('[data-reset]').addEventListener('click', () => {
    working = clone(original);
    renderAll();
    toast('Changes discarded.', { type: 'default' });
  });

  $('[data-save]').addEventListener('click', async () => {
    const errorBox = $('[data-error]');
    const savedBox = $('[data-saved]');
    errorBox.hidden = true;
    savedBox.hidden = true;

    // normalize positions to be contiguous within each step
    for (const step of [1, 2]) {
      working
        .filter((f) => Number(f.step) === step)
        .sort((a, b) => a.position - b.position)
        .forEach((field, index) => {
          field.position = index + 1;
        });
    }

    const payload = working.map((field) => ({
      field_key: field.field_key,
      enabled: Boolean(field.enabled),
      required: Boolean(field.required),
      position: field.position,
    }));

    try {
      await saveFormFields(payload);
      original = clone(working);
      savedBox.hidden = false;
      toast('Form saved.', { type: 'success' });
      setTimeout(() => { savedBox.hidden = true; }, 4000);
    } catch (error) {
      errorBox.textContent = error?.message || 'Could not save the form.';
      errorBox.hidden = false;
      toast(error?.message || 'Save failed.', { type: 'error' });
    }
  });
}

boot();
