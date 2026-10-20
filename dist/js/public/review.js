// Review step: read-only summary of the application plus the print sheet used for
// browser-print PDF generation (no client-side PDF library).

import { el, clearNode } from '../utils/dom.js';
import { formatBytes } from '../utils/format.js';
import { hasReadyScreenshot } from './product-grid.js';

function row(label, value) {
  const display = value && String(value).trim() ? String(value) : '—';
  return el('div', { class: 'review-row' }, [
    el('dt', { class: 'review-row__label', text: label }),
    el('dd', { class: 'review-row__value', text: display }),
  ]);
}

function section(title, rows) {
  const dl = el('dl', { class: 'review-section__list' });
  rows.forEach(([label, value]) => dl.append(row(label, value)));
  return el('section', { class: 'review-section' }, [
    el('h3', { class: 'review-section__title', text: title }),
    dl,
  ]);
}

function handlesSummary(otherHandles) {
  const active = (otherHandles || []).filter(
    (item) => (item.platform || '').trim() || (item.handle || '').trim(),
  );
  if (!active.length) return '';
  return active.map((item) => `${item.platform}: ${item.handle}`).join('\n');
}

export function renderReview({ state, container, settings = {} }) {
  clearNode(container);

  const fields = state.fields || {};
  // Same list the submission payload uses: fields that contain an uploaded screenshot.
  const products = (state.products || []).filter(hasReadyScreenshot);

  const personalRows = [
    ['Full name', fields.full_name],
    ['Email', fields.email],
    ['Phone', fields.phone],
  ].filter(([, value]) => value && String(value).trim());

  const addressRows = [
    ['Street', fields.address_street],
    ['Line 2', fields.address_line2],
    ['City', fields.address_city],
    ['Region', fields.address_region],
    ['Postal code', fields.address_postal_code],
    ['Country', fields.address_country],
  ];

  const socialRows = [
    ['Instagram', fields.instagram_handle],
    ['TikTok', fields.tiktok_handle],
    ['Other platforms', handlesSummary(state.otherHandles)],
    ['Portfolio', fields.portfolio_url],
    ['Rate / budget', fields.budget],
  ];

  const containerEl = el('div', { class: 'review' });
  containerEl.append(
    el('p', { class: 'review__hint', text: 'Please check your answers carefully. You can go back to any step to make changes before submitting.' }),
  );

  containerEl.append(section('Your details', personalRows));
  containerEl.append(section('Delivery address', addressRows));
  containerEl.append(section('Creator channels', socialRows));

  // Screenshots
  const productSection = el('section', { class: 'review-section' }, [
    el('h3', { class: 'review-section__title', text: `Product screenshots (${products.length})` }),
  ]);
  if (!products.length) {
    productSection.append(el('p', { class: 'review__empty', text: 'No screenshots added yet.' }));
  } else {
    const list = el('ol', { class: 'review-products' });
    products.forEach((product, index) => {
      const card = el('li', { class: 'review-product' });
      card.append(el('h4', { class: 'review-product__title', text: `Screenshot ${index + 1}` }));
      const previews = (product.files || []).filter((file) => file.previewUrl);
      if (previews.length) {
        const thumbs = el('div', { class: 'review-product__thumbs' });
        previews.forEach((file) => {
          thumbs.append(
            el('img', {
              class: 'review-product__thumb',
              src: file.previewUrl,
              alt: `Screenshot ${index + 1}: ${file.originalName || 'uploaded image'}`,
            }),
          );
        });
        card.append(thumbs);
      }
      const meta = el('dl', { class: 'review-section__list' });
      meta.append(row('File', product.files.filter((f) => f.status === 'ready').map((f) => `${f.originalName} (${formatBytes(f.size)})`).join(', ')));
      card.append(meta);
      list.append(card);
    });
    productSection.append(list);
  }
  containerEl.append(productSection);

  // Consent summary
  const termsSection = el('section', { class: 'review-section' }, [
    el('h3', { class: 'review-section__title', text: 'Terms & consent' }),
  ]);
  const termsDl = el('dl', { class: 'review-section__list' });
  termsDl.append(row('Terms version', state.consent?.reviewedVersion || state.terms?.version || '—'));
  termsDl.append(row('Consent recorded', state.consent?.checked ? 'Yes' : 'Not yet — confirm on the next step'));
  termsSection.append(termsDl);
  containerEl.append(termsSection);

  // Print sheet (used by the "Save as PDF" print flow)
  const printSheet = el('div', { class: 'print-sheet', 'aria-hidden': 'true' });
  printSheet.append(el('h1', { text: `Partnership application — ${settings.brand_name || ''}`.trim() }));
  printSheet.append(el('p', { text: `Prepared ${new Date().toLocaleString()}` }));
  const printDl = el('dl', { class: 'print-sheet__list' });
  [
    ['Name', fields.full_name],
    ['Email', fields.email],
    ['Phone', fields.phone],
    ['Address', [fields.address_street, fields.address_line2, fields.address_city, fields.address_region, fields.address_postal_code, fields.address_country].filter(Boolean).join(', ')],
    ['Instagram', fields.instagram_handle],
    ['TikTok', fields.tiktok_handle],
    ['Other', handlesSummary(state.otherHandles)],
    ['Portfolio', fields.portfolio_url],
    ['Screenshots', String(products.length)],
  ].forEach(([label, value]) => printDl.append(row(label, value)));
  printSheet.append(printDl);
  containerEl.append(printSheet);

  container.append(containerEl);

  return {
    element: containerEl,
    print() {
      window.print();
    },
  };
}

/**
 * Builds a printable snapshot for an arbitrary application row (admin side).
 * Renders into a hidden container, waits for every product image to finish
 * loading (so the PDF never shows blank image spaces), then triggers the
 * browser print dialog — a proper document, not a screenshot of the page.
 */
export async function printApplicationSnapshot(application, { products = [], filesByProduct = new Map(), settings = {} } = {}) {
  const host = el('div', { class: 'print-sheet print-sheet--standalone', 'aria-hidden': 'true' });
  host.append(el('h1', { text: `Application ${application.reference || ''}`.trim() }));
  host.append(el('p', { text: `${settings.brand_name || 'Fortuna Skin'} · Submitted ${application.submitted_at ? new Date(application.submitted_at).toLocaleString() : '—'}` }));

  const dl = el('dl', { class: 'print-sheet__list' });
  [
    ['Name', application.full_name],
    ['Email', application.email],
    ['Phone', application.phone],
    ['Address', [application.address_street, application.address_line2, application.address_city, application.address_region, application.address_postal_code, application.address_country].filter(Boolean).join(', ')],
    ['Instagram', application.instagram_handle],
    ['TikTok', application.tiktok_handle],
    ['Other handles', Array.isArray(application.other_handles) ? application.other_handles.map((h) => `${h.platform}: ${h.handle}`).join(', ') : ''],
    ['Portfolio', application.portfolio_url],
    ['Budget', application.budget],
    ['Status', application.status],
    ['Terms version', application.terms_version],
  ].forEach(([label, value]) => dl.append(row(label, value)));
  host.append(dl);

  host.append(el('h2', { text: `Products (${products.length})` }));
  const list = el('ol', { class: 'print-sheet__products' });
  products.forEach((product) => {
    const li = el('li', { class: 'print-sheet__product' });
    li.append(el('strong', { text: product.name || '—' }));
    if (product.url) li.append(el('div', { text: product.url }));
    if (product.variant) li.append(el('div', { text: `Variant: ${product.variant}` }));
    if (product.notes) li.append(el('div', { text: product.notes }));
    const files = filesByProduct.get(product.id) || [];
    if (files.length) {
      const ul = el('ul', { class: 'print-sheet__files' });
      files.forEach((file) => {
        const item = el('li');
        const src = file.signed_url || file.url || '';
        if (src) {
          item.append(
            el('img', {
              class: 'print-sheet__img',
              src,
              alt: file.original_name || 'Application screenshot',
            }),
          );
        }
        const caption = [file.original_name || (file.storage_path || '').split('/').pop() || 'image', formatBytes(file.file_size || 0)].join(' · ');
        item.append(el('div', { class: 'print-muted', text: caption }));
        ul.append(item);
      });
      li.append(ul);
    }
    list.append(li);
  });
  host.append(list);

  document.body.append(host);

  // Wait for every image to finish loading (or fail/timeout) BEFORE printing,
  // so the printed PDF never contains blank image placeholders.
  const images = Array.from(host.querySelectorAll('img'));
  await Promise.all(
    images.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 10000);
      });
    }),
  );

  const cleanup = () => {
    host.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Safety cleanup in case afterprint never fires
  setTimeout(cleanup, 30000);
  return cleanup;
}
