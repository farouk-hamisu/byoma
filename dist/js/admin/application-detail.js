// Application detail: full record, product images via signed URLs, status workflow,
// reviewer assignment, notes, history and print.

import { $, el, clearNode } from '../utils/dom.js';
import { formatDateTime, formatBytes, statusLabel } from '../utils/format.js';
import { toast } from '../utils/toast.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import {
  getApplication,
  getApplicationProducts,
  getApplicationNotes,
  getStatusHistory,
  updateApplicationStatus,
  assignReviewer,
  addNote,
  listAdmins,
  createSignedUrl,
} from './api.js';
import { printApplicationSnapshot } from '../public/review.js';

const applicationId = new URLSearchParams(window.location.search).get('id');

let application = null;
let products = [];
let settings = null;

function detailRow(label, value, { href = '' } = {}) {
  const dd = el('dd', { class: 'detail-list__value' });
  if (!value || value === '') {
    dd.textContent = '—';
  } else if (href) {
    dd.append(el('a', { href, text: String(value), rel: 'noopener noreferrer', target: '_blank' }));
  } else {
    dd.textContent = String(value);
  }
  return el('div', { class: 'detail-list__row' }, [
    el('dt', { class: 'detail-list__label', text: label }),
    dd,
  ]);
}

function renderApplicant(app) {
  const dl = $('[data-applicant]');
  clearNode(dl);
  const handles = [];
  if (app.instagram_handle) handles.push(`Instagram: ${app.instagram_handle}`);
  if (app.tiktok_handle) handles.push(`TikTok: ${app.tiktok_handle}`);
  if (Array.isArray(app.other_handles)) {
    for (const item of app.other_handles) handles.push(`${item.platform}: ${item.handle}`);
  }
  const address = [
    app.address_street,
    app.address_line2,
    app.address_city,
    app.address_region,
    app.address_postal_code,
    app.address_country,
  ].filter(Boolean).join(', ');

  dl.append(
    detailRow('Reference', app.reference),
    detailRow('Full name', app.full_name),
    detailRow('Email', app.email, { href: app.email ? `mailto:${app.email}` : '' }),
    detailRow('Phone', app.phone),
    detailRow('Address', address),
    detailRow('Instagram', app.instagram_handle),
    detailRow('TikTok', app.tiktok_handle),
    detailRow('Other handles', handles.slice(2).join(' · ')),
    detailRow('Portfolio', app.portfolio_url, { href: app.portfolio_url || '' }),
    detailRow('Rate / budget', app.budget),
    detailRow('Submitted', formatDateTime(app.submitted_at)),
    detailRow('First response', formatDateTime(app.first_response_at)),
    detailRow('IP', app.submission_ip),
  );
}

function renderTerms(app) {
  const dl = $('[data-terms]');
  clearNode(dl);
  dl.append(
    detailRow('Version accepted', app.terms_version),
    detailRow('Accepted at', formatDateTime(app.terms_accepted_at)),
    detailRow('Consent recorded', app.consent_confirmed ? 'Yes' : 'No'),
    detailRow('Document ID', app.terms_document_id),
  );
}

async function renderProducts() {
  const wrap = $('[data-products]');
  clearNode(wrap);
  $('[data-product-count]').textContent = `(${products.length})`;
  if (!products.length) {
    wrap.append(el('p', { class: 'admin-page-subtitle', text: 'No products on this application.' }));
    return;
  }
  for (const product of products) {
    const card = el('article', { class: 'detail-product' });
    card.append(
      el('h3', { class: 'detail-product__title', text: `${product.position}. ${product.name || 'Untitled'}` }),
    );
    const meta = el('dl', { class: 'detail-list' });
    meta.append(
      detailRow('Variant', product.variant),
      detailRow('Link', product.url, { href: product.url || '' }),
      detailRow('Notes', product.notes),
    );
    card.append(meta);

    const files = product.application_product_files || [];
    if (files.length) {
      const thumbs = el('div', { class: 'detail-thumbs' });
      for (const file of files) {
        const anchor = el('a', {
          class: 'detail-thumb',
          href: '#',
          title: file.original_name || 'Open image',
        });
        const pending = el('span', { class: 'detail-thumb--pending', text: 'Loading…' });
        anchor.append(pending);
        thumbs.append(anchor);
        createSignedUrl('product-uploads', file.storage_path, 3600)
          .then((url) => {
            clearNode(anchor);
            anchor.href = url;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.append(el('img', { src: url, alt: file.original_name || 'Product photo', loading: 'lazy' }));
          })
          .catch(() => {
            pending.textContent = 'Unavailable';
          });
      }
      card.append(thumbs);
      card.append(
        el('p', {
          class: 'admin-page-subtitle',
          text: files.map((f) => `${f.original_name || f.storage_path.split('/').pop()} (${formatBytes(f.file_size || 0)})`).join(' · '),
        }),
      );
    }
    wrap.append(card);
  }
}

async function renderNotes() {
  const wrap = $('[data-notes]');
  clearNode(wrap);
  try {
    const notes = await getApplicationNotes(applicationId);
    if (!notes.length) {
      wrap.append(el('p', { class: 'admin-page-subtitle', text: 'No notes yet.' }));
      return;
    }
    for (const note of notes) {
      const author = note.admin_profiles?.full_name || note.admin_profiles?.email || 'Admin';
      wrap.append(
        el('div', { class: 'note' }, [
          el('div', { class: 'note__meta', text: `${author} · ${formatDateTime(note.created_at)}` }),
          el('p', { class: 'note__body', text: note.body }),
        ]),
      );
    }
  } catch (error) {
    wrap.append(el('p', { class: 'admin-page-subtitle', text: error?.message || 'Could not load notes.' }));
  }
}

async function renderHistory() {
  const wrap = $('[data-history]');
  clearNode(wrap);
  try {
    const rows = await getStatusHistory(applicationId);
    if (!rows.length) {
      wrap.append(el('li', { class: 'admin-page-subtitle', text: 'No status changes yet.' }));
      return;
    }
    for (const row of rows) {
      const who = row.admin_profiles?.full_name || 'Admin';
      const reason = row.reason ? ` — ${row.reason}` : '';
      wrap.append(
        el('li', { class: 'history-item' }, [
          el('span', { class: 'history-item__time', text: formatDateTime(row.changed_at) }),
          el('span', { text: `${who}: ${statusLabel(row.from_status)} → ${statusLabel(row.to_status)}${reason}` }),
        ]),
      );
    }
  } catch (error) {
    wrap.append(el('li', { class: 'admin-page-subtitle', text: error?.message || 'Could not load history.' }));
  }
}

async function loadReviewerOptions() {
  const select = $('#reviewer-select');
  const admins = await listAdmins().catch(() => []);
  for (const admin of admins) {
    select.append(el('option', { value: admin.id, text: admin.full_name || admin.email }));
  }
  select.value = application.reviewer_id || '';
  select.addEventListener('change', async () => {
    try {
      await assignReviewer({ applicationId, reviewerId: select.value || null });
      toast('Reviewer updated.', { type: 'success' });
      application.reviewer_id = select.value || null;
    } catch (error) {
      toast(error?.message || 'Could not update reviewer.', { type: 'error' });
      select.value = application.reviewer_id || '';
    }
  });
}

function bindStatus() {
  const select = $('#status-select');
  const reason = $('#status-reason');
  select.value = application.status;
  $('[data-save-status]').addEventListener('click', async () => {
    const toStatus = select.value;
    if (toStatus === application.status) {
      toast('Status is unchanged.', { type: 'warning' });
      return;
    }
    try {
      const updated = await updateApplicationStatus({
        applicationId,
        toStatus,
        reason: reason.value.trim(),
      });
      application = { ...application, ...updated };
      select.value = updated.status;
      reason.value = '';
      $('[data-title]').textContent = `${updated.reference} · ${statusLabel(updated.status)}`;
      toast('Status updated.', { type: 'success' });
      renderHistory();
    } catch (error) {
      toast(error?.message || 'Could not update status.', { type: 'error' });
    }
  });
}

function bindNotes() {
  $('[data-note-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = $('#note-body');
    const body = textarea.value.trim();
    if (!body) return;
    try {
      await addNote({ applicationId, body });
      textarea.value = '';
      renderNotes();
      toast('Note added.', { type: 'success' });
    } catch (error) {
      toast(error?.message || 'Could not add note.', { type: 'error' });
    }
  });
}

function bindPrint() {
  const btn = $('[data-print]');
  btn.addEventListener('click', async () => {
    if (!application) return;
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
      // Fresh signed URLs at print time so images never fail with expired tokens
      const filesByProduct = new Map();
      for (const product of products) {
        const files = product.application_product_files || [];
        const withUrls = await Promise.all(
          files.map(async (file) => {
            try {
              const url = await createSignedUrl('product-uploads', file.storage_path, 3600);
              return { ...file, signed_url: url };
            } catch {
              return { ...file, signed_url: '' };
            }
          }),
        );
        filesByProduct.set(product.id, withUrls);
      }
      await printApplicationSnapshot(application, { products, filesByProduct, settings });
    } finally {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  });
}

function showError(message) {
  const box = $('[data-page-error]');
  box.textContent = message;
  box.hidden = false;
  $('[data-detail]').hidden = true;
}

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Applications' });
  renderMobileToggle();

  if (!applicationId) {
    showError('No application selected. Pick one from the list.');
    return;
  }

  try {
    application = await getApplication(applicationId);
    products = await getApplicationProducts(applicationId);
    const { getSettings } = await import('./api.js');
    settings = await getSettings().catch(() => ({}));

    $('[data-title]').textContent = `${application.reference} · ${statusLabel(application.status)}`;
    $('[data-subtitle]').textContent = `Submitted ${formatDateTime(application.submitted_at)}`;

    renderApplicant(application);
    renderTerms(application);
    await renderProducts();
    await renderNotes();
    await renderHistory();
    await loadReviewerOptions();
    bindStatus();
    bindNotes();
    bindPrint();

    $('[data-detail]').hidden = false;
  } catch (error) {
    console.error('application detail failed', error);
    showError(error?.message || 'Could not load this application.');
  }
}

boot();
