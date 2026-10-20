// Terms administration: upload PDF to private storage, register version, publish /
// unpublish / delete with server-side guards.

import { $, el, clearNode } from '../utils/dom.js';
import { formatDateTime, formatBytes } from '../utils/format.js';
import { toast } from '../utils/toast.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import {
  listTerms,
  registerTerms,
  publishTerms,
  unpublishTerms,
  deleteTerms,
  createSignedUpload,
  uploadSigned,
  createSignedUrl,
  sha256OfFile,
} from './api.js';

const MAX_BYTES = 25 * 1024 * 1024;

function flash(type, message) {
  const box = type === 'success' ? $('[data-saved]') : $('[data-error]');
  box.textContent = message;
  box.hidden = false;
  setTimeout(() => { box.hidden = true; }, 5000);
}

function renderRows(rows) {
  const tbody = $('[data-rows]');
  clearNode(tbody);
  if (!rows.length) {
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '6', text: 'No terms documents yet. Upload your first version above.' })]));
    return;
  }
  for (const row of rows) {
    const tr = el('tr');
    tr.append(
      el('td', { text: row.version }),
      el('td', { text: row.title || '—' }),
      el('td', {}, [
        el('span', {
          class: `badge ${row.is_current && row.status === 'published' ? 'badge--approved' : row.status === 'published' ? 'badge--new' : 'badge--neutral'}`,
          text: row.is_current && row.status === 'published' ? 'Current' : row.status,
        }),
      ]),
      el('td', { text: formatBytes(row.file_size || 0) }),
      el('td', { text: formatDateTime(row.created_at) }),
    );

    const actions = el('td');
    const view = el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      text: 'View',
      onClick: async () => {
        try {
          const url = await createSignedUrl('terms-docs', row.storage_path, 3600);
          window.open(url, '_blank', 'noopener');
        } catch (error) {
          toast(error?.message || 'Could not open the document.', { type: 'error' });
        }
      },
    });
    actions.append(view);

    if (row.status === 'draft' || !row.is_current) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn--primary btn--sm',
          text: row.is_current ? 'Publish' : 'Publish as current',
          onClick: async () => {
            if (!window.confirm(`Publish version "${row.version}" as the current Terms applicants must accept?`)) return;
            try {
              await publishTerms({ id: row.id });
              flash('success', `Version ${row.version} is now current.`);
              refresh();
            } catch (error) {
              toast(error?.message || 'Publish failed.', { type: 'error' });
            }
          },
        }),
      );
    } else if (row.is_current && row.status === 'published') {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn--secondary btn--sm',
          text: 'Unpublish',
          onClick: async () => {
            if (!window.confirm(`Unpublish version "${row.version}"? Applicants will not be able to submit until another version is published.`)) return;
            try {
              await unpublishTerms({ id: row.id });
              flash('success', `Version ${row.version} unpublished.`);
              refresh();
            } catch (error) {
              toast(error?.message || 'Unpublish failed.', { type: 'error' });
            }
          },
        }),
      );
    }

    if (!row.is_current) {
      actions.append(
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          text: 'Delete',
          onClick: async () => {
            if (!window.confirm(`Delete version "${row.version}" permanently?`)) return;
            try {
              await deleteTerms({ id: row.id });
              flash('success', `Version ${row.version} deleted.`);
              refresh();
            } catch (error) {
              toast(error?.message || 'Delete failed.', { type: 'error' });
            }
          },
        }),
      );
    }
    tr.append(actions);
    tbody.append(tr);
  }
}

async function refresh() {
  try {
    const rows = await listTerms();
    renderRows(rows);
  } catch (error) {
    const tbody = $('[data-rows]');
    clearNode(tbody);
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '6', text: error?.message || 'Could not load terms.' })]));
  }
}

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Terms' });
  renderMobileToggle();
  refresh();

  $('[data-upload-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $('#terms-title').value.trim();
    const description = $('#terms-description').value.trim();
    const version = $('#terms-version').value.trim();
    const file = $('#terms-file').files[0];

    const errorBox = $('[data-error]');
    errorBox.hidden = true;

    if (!title || !version || !file) {
      flash('error', 'Title, version and a PDF file are required.');
      return;
    }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      flash('error', 'Only PDF files can be uploaded.');
      return;
    }
    if (file.size > MAX_BYTES) {
      flash('error', 'The file is larger than 25 MB.');
      return;
    }

    const submit = $('[data-upload-submit]');
    submit.disabled = true;
    submit.textContent = 'Uploading…';

    try {
      const objectName = `${crypto.randomUUID()}.pdf`;
      const path = `terms-docs/${objectName}`;
      const signed = await createSignedUpload('terms-docs', path);
      await uploadSigned({ bucket: 'terms-docs', path, token: signed.token, file });
      const sha256 = await sha256OfFile(file);
      const created = await registerTerms({
        title,
        description,
        version,
        storagePath: path,
        fileSize: file.size,
        sha256,
      });
      // First version (no published/current document yet): publish immediately so
      // applicants can open and accept it right away. Later uploads stay drafts
      // until the administrator explicitly publishes them.
      const rows = await listTerms();
      const hasCurrent = rows.some((row) => row.is_current && row.status === 'published');
      let publishedNow = false;
      if (!hasCurrent && created?.id) {
        try {
          await publishTerms({ id: created.id });
          publishedNow = true;
        } catch {
          /* keep the draft; the row still shows a Publish action */
        }
      }
      flash(
        'success',
        publishedNow
          ? `Version ${version} uploaded and published — applicants can accept it now.`
          : `Version ${version} registered. Publish it to make it current.`,
      );
      event.target.reset();
      refresh();
    } catch (error) {
      flash('error', error?.message || 'Upload failed.');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Upload & register';
    }
  });
}

boot();
