// Renders administrator-configured fields for wizard steps 1 (details) and 2 (channels).

import { el, clearNode } from '../utils/dom.js';
import { COUNTRIES } from '../utils/countries.js';
import { runRules, requiredRule, maxLengthRule, FIELD_VALIDATORS, validateUrl, validateHandle } from '../utils/validate.js';

const MAX_LEN = {
  full_name: 200,
  email: 254,
  phone: 40,
  address_street: 300,
  address_line2: 300,
  address_city: 200,
  address_region: 200,
  address_postal_code: 40,
  address_country: 120,
  instagram_handle: 60,
  tiktok_handle: 60,
  portfolio_url: 500,
  budget: 120,
};

const MAX_HANDLES = 20;

export function validateField(field, value) {
  const key = field.field_key;
  const required = field.required || field.locked;
  const trimmed = typeof value === 'string' ? value.trim() : value;

  if (required && (!trimmed || String(trimmed).length === 0)) {
    return `${field.label} is required.`;
  }
  if (!trimmed) return null;

  const max = MAX_LEN[key];
  if (max && String(trimmed).length > max) {
    return `${field.label} must be ${max} characters or fewer.`;
  }

  const rules = [];
  const validator = FIELD_VALIDATORS[key];
  if (validator) rules.push(validator);
  if (max) rules.push(maxLengthRule(max, field.label));
  const result = runRules(trimmed, rules);
  return result;
}

function baseInputAttrs(field) {
  const attrs = {
    id: `field-${field.field_key}`,
    name: field.field_key,
    autocomplete: autocompleteFor(field.field_key),
    maxlength: String(MAX_LEN[field.field_key] || 500),
  };
  if (field.placeholder) attrs.placeholder = field.placeholder;
  if (field.required || field.locked) attrs.required = true;
  return attrs;
}

function autocompleteFor(key) {
  const map = {
    full_name: 'name',
    email: 'email',
    phone: 'tel',
    address_street: 'address-line1',
    address_line2: 'address-line2',
    address_city: 'address-level2',
    address_region: 'address-level1',
    address_postal_code: 'postal-code',
    address_country: 'country',
  };
  return map[key] || 'on';
}

function renderCountrySelect(field, value, onChange) {
  const select = el('select', { ...baseInputAttrs(field), class: 'input' });
  select.append(el('option', { value: '', text: field.placeholder || 'Select…' }));
  for (const country of COUNTRIES) {
    select.append(el('option', { value: country, text: country, selected: country === value }));
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function renderText(field, value, onChange, { type = 'text', inputClass = 'input' } = {}) {
  const input = el('input', { ...baseInputAttrs(field), type, class: inputClass, value: value || '' });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function renderFieldControl(field, value, onChange) {
  switch (field.field_type) {
    case 'email':
      return renderText(field, value, onChange, { type: 'email', inputClass: 'input' });
    case 'tel':
      return renderText(field, value, onChange, { type: 'tel' });
    case 'url':
      return renderText(field, value, onChange, { type: 'url' });
    case 'country':
      return renderCountrySelect(field, value, onChange);
    case 'textarea': {
      const textarea = el('textarea', { ...baseInputAttrs(field), class: 'input input--textarea', rows: '4' });
      textarea.value = value || '';
      textarea.addEventListener('input', () => onChange(textarea.value));
      return textarea;
    }
    case 'select': {
      const select = el('select', { ...baseInputAttrs(field), class: 'input' });
      select.append(el('option', { value: '', text: field.placeholder || 'Select…' }));
      const choices = Array.isArray(field.options?.choices) ? field.options.choices : [];
      for (const choice of choices) {
        const [val, label] = Array.isArray(choice) ? choice : [choice, choice];
        select.append(el('option', { value: val, text: label, selected: val === value }));
      }
      select.addEventListener('change', () => onChange(select.value));
      return select;
    }
    default:
      return renderText(field, value, onChange);
  }
}

function buildFieldRow(field, state, onChange) {
  const key = field.field_key;
  const required = field.required || field.locked;
  const errorId = `error-${key}`;

  const input = renderFieldControl(field, state.fields[key], (next) => {
    onChange(key, next);
  });
  if (required) input.setAttribute('aria-required', 'true');

  const label = el('label', { class: 'field__label', for: `field-${key}` }, [
    document.createTextNode(field.label),
    required ? el('span', { class: 'field__required', 'aria-hidden': 'true', text: ' *' }) : null,
  ].filter(Boolean));

  const children = [label];
  if (field.helper_text) {
    children.push(el('p', { class: 'field__help', id: `help-${key}`, text: field.helper_text }));
    input.setAttribute('aria-describedby', `help-${key}`);
  }
  children.push(input);
  children.push(el('p', { class: 'field__error', id: errorId, hidden: true, role: 'alert' }));

  const row = el('div', {
    class: 'field',
    'data-field': key,
  }, children);
  return row;
}

function validateHandleOrUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return validateUrl(raw);
  return validateHandle(raw);
}

function validateHandlesList(items) {
  const errors = [];
  items.forEach((item, index) => {
    const platform = (item.platform || '').trim();
    const handle = (item.handle || '').trim();
    if (!platform && !handle) return;
    if (!platform) {
      errors.push({ index, message: 'Add a platform name (e.g. YouTube).' });
      return;
    }
    if (!handle) {
      errors.push({ index, message: `Add your @handle or profile URL for ${platform}.` });
      return;
    }
    const handleError = validateHandleOrUrl(handle);
    if (handleError) {
      errors.push({ index, message: `${platform}: ${handleError}` });
    }
  });
  return errors;
}

function buildHandlesField(field, state, onChange) {
  const wrap = el('div', { class: 'field field--handles', 'data-field': field.field_key });
  wrap.append(
    el('span', { class: 'field__label', text: field.label }),
  );
  if (field.helper_text) {
    wrap.append(el('p', { class: 'field__help', text: field.helper_text }));
  }

  const list = el('div', { class: 'handles-list', role: 'group', 'aria-label': field.label });
  const addBtn = el('button', {
    type: 'button',
    class: 'btn btn--secondary btn--sm',
    text: '+ Add platform',
  });
  const errorNode = el('p', { class: 'field__error', hidden: true, role: 'alert' });

  function focusRow(index) {
    const rows = list.querySelectorAll('.handles-list__row');
    const target = rows[index] || rows[rows.length - 1];
    const input = target && target.querySelector('input');
    if (input) input.focus();
  }

  function renderList(focusIndex) {
    clearNode(list);
    state.otherHandles.forEach((item, index) => {
      const row = el('div', { class: 'handles-list__row' });
      const platform = el('input', {
        class: 'input',
        type: 'text',
        placeholder: 'Platform (e.g. YouTube)',
        value: item.platform || '',
        'aria-label': `Platform ${index + 1}`,
        maxlength: '60',
      });
      platform.addEventListener('input', () => onChange(`handle:${index}:platform`, platform.value));
      const handle = el('input', {
        class: 'input',
        type: 'text',
        placeholder: '@handle or https://…',
        value: item.handle || '',
        'aria-label': `Handle or profile URL ${index + 1}`,
        maxlength: '120',
      });
      handle.addEventListener('input', () => onChange(`handle:${index}:handle`, handle.value));
      const remove = el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm handles-list__remove',
        text: 'Remove',
        'aria-label': `Remove platform ${index + 1}`,
      });
      row.append(platform, handle, remove);
      list.append(row);
    });
    addBtn.disabled = state.otherHandles.length >= MAX_HANDLES;
    addBtn.textContent = addBtn.disabled
      ? `Maximum ${MAX_HANDLES} platforms`
      : '+ Add platform';
    if (typeof focusIndex === 'number') focusRow(focusIndex);
  }

  addBtn.addEventListener('click', () => {
    if (state.otherHandles.length >= MAX_HANDLES) return;
    onChange('handle:add', null);
    renderList(state.otherHandles.length - 1);
  });
  list.addEventListener('click', (event) => {
    if (!event.target.classList.contains('handles-list__remove')) return;
    const rows = Array.from(list.querySelectorAll('.handles-list__row'));
    const index = rows.indexOf(event.target.closest('.handles-list__row'));
    if (index < 0) return;
    onChange('handle:remove', index);
    renderList(state.otherHandles.length ? Math.min(index, state.otherHandles.length - 1) : undefined);
  });

  renderList();
  wrap.append(list, addBtn, errorNode);
  return wrap;
}

/**
 * Renders a step's fields into `container`.
 * `state` provides fields + otherHandles; `onFieldChange(key, value)` receives updates
 * (handle:* keys use the special syntax described in wizard.js).
 */
export function renderFieldStep({ container, fields, state, onFieldChange, legend, description }) {
  clearNode(container);
  const enabled = fields.filter((field) => field.enabled !== false);

  const intro = el('div', { class: 'step-intro' });
  intro.append(el('h2', { class: 'step-intro__title', text: legend }));
  if (description) intro.append(el('p', { class: 'step-intro__description', text: description }));
  container.append(intro);

  const form = el('form', { class: 'field-grid', novalidate: true });
  form.addEventListener('submit', (event) => event.preventDefault());

  for (const field of enabled) {
    if (field.field_type === 'handles') {
      form.append(buildHandlesField(field, state, onFieldChange));
    } else {
      form.append(buildFieldRow(field, state, onFieldChange));
    }
  }

  container.append(form);
  return {
    /** Returns a list of {key, message} for the first invalid fields (max 5). */
    validate() {
      const errors = [];
      for (const field of enabled) {
        if (field.field_type === 'handles') continue;
        const message = validateField(field, state.fields[field.field_key] || '');
        if (message) errors.push({ key: field.field_key, message });
      }
      const handlesField = enabled.find((f) => f.field_type === 'handles');
      if (handlesField) {
        for (const issue of validateHandlesList(state.otherHandles)) {
          errors.push({ key: handlesField.field_key, message: issue.message });
        }
      }
      return errors;
    },
    /** Paints inline errors and moves focus to the first invalid control. */
    showErrors(errors) {
      container.querySelectorAll('.field').forEach((row) => {
        const errorNode = row.querySelector('.field__error');
        if (errorNode) {
          errorNode.hidden = true;
          errorNode.textContent = '';
        }
        row.removeAttribute('data-invalid');
      });
      for (const error of errors) {
        const row = container.querySelector(`[data-field="${error.key}"]`);
        if (!row) continue;
        row.setAttribute('data-invalid', 'true');
        const errorNode = row.querySelector('.field__error');
        if (errorNode) {
          errorNode.textContent = error.message;
          errorNode.hidden = false;
        }
      }
      const first = errors[0] && container.querySelector(`[data-field="${errors[0].key}"] .input, [data-field="${errors[0].key}"] input`);
      first?.focus();
    },
    clearErrors() {
      this.showErrors([]);
    },
  };
}

export { validateHandlesList };
