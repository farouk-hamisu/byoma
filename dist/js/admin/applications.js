// Applications list: filters, pagination, multi-select bulk status changes.

import { $, $$, el, clearNode, debounce } from '../utils/dom.js';
import { formatDateTime, statusLabel } from '../utils/format.js';
import { toast } from '../utils/toast.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import { listApplications, bulkUpdateStatus, listAdmins } from './api.js';

const PAGE_SIZE = 25;
const state = {
  search: '',
  status: '',
  reviewer: '',
  sort: 'submitted_at.desc',
  page: 0,
  total: 0,
  rows: [],
  selected: new Set(),
};

function selectedIds() {
  return Array.from(state.selected);
}

function updateBulkBar() {
  const bar = $('[data-bulk]');
  const count = state.selected.size;
  bar.hidden = count === 0;
  $('[data-bulk-count]').textContent = `${count} selected`;
}

function renderRows() {
  const tbody = $('[data-rows]');
  clearNode(tbody);
  if (!state.rows.length) {
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '10', text: 'No applications match these filters.' })]));
    return;
  }
  for (const row of state.rows) {
    const tr = el('tr', { 'data-id': row.id });
    const checkbox = el('input', {
      type: 'checkbox',
      'aria-label': `Select ${row.reference}`,
    });
    checkbox.checked = state.selected.has(row.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(row.id);
      else state.selected.delete(row.id);
      updateBulkBar();
    });
    tr.append(el('td', { class: 'checkbox-cell' }, [checkbox]));

    const refCell = el('td');
    refCell.append(el('a', { href: `/admin/application.html?id=${row.id}`, text: row.reference || '—' }));
    const handles = [row.instagram_handle, row.tiktok_handle].filter(Boolean).join(' · ');

    tr.append(
      refCell,
      el('td', { text: row.full_name || '—' }),
      el('td', { text: row.email || '—' }),
      el('td', { text: handles || '—' }),
      el('td', {}, [el('span', { class: `badge badge--${row.status}`, text: statusLabel(row.status) })]),
      el('td', { text: String(row.product_count ?? 0) }),
      el('td', { text: formatDateTime(row.submitted_at) }),
      el('td', { text: row.reviewer_name || '—' }),
      el('td', {}, [
        el('a', {
          class: 'btn btn--secondary btn--sm',
          href: `/admin/application.html?id=${row.id}`,
          text: 'View',
        }),
      ]),
    );
    tbody.append(tr);
  }
}

function renderPagination() {
  const start = state.total === 0 ? 0 : state.page * PAGE_SIZE + 1;
  const end = Math.min(state.total, (state.page + 1) * PAGE_SIZE);
  $('[data-page-info]').textContent = `${start}–${end} of ${state.total}`;
  $('[data-prev]').disabled = state.page === 0;
  $('[data-next]').disabled = end >= state.total;
}

async function load() {
  const tbody = $('[data-rows]');
  tbody.innerHTML = '<tr><td colspan="10" class="empty">Loading…</td></tr>';
  try {
    const [result, admins] = await Promise.all([
      listApplications({
        search: state.search,
        status: state.status,
        reviewer: state.reviewer,
        sort: state.sort,
        page: state.page,
        pageSize: PAGE_SIZE,
      }),
      listAdmins().catch(() => []),
    ]);

    const nameById = new Map(admins.map((a) => [a.id, a.full_name || a.email]));
    state.rows = result.rows.map((row) => ({ ...row, reviewer_name: nameById.get(row.reviewer_id) || '' }));
    state.total = result.total;

    // populate reviewer filter once
    const reviewerSelect = $('#reviewer');
    if (reviewerSelect && reviewerSelect.options.length <= 2) {
      for (const admin of admins) {
        reviewerSelect.append(el('option', { value: admin.id, text: admin.full_name || admin.email }));
      }
    }

    state.selected.clear();
    updateBulkBar();
    renderRows();
    renderPagination();
  } catch (error) {
    console.error('applications load failed', error);
    clearNode(tbody);
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '10', text: error?.message || 'Could not load applications.' })]));
  }
}

function bindFilters() {
  const form = $('[data-filters]');
  const runSearch = debounce(() => {
    state.search = form.search.value.trim();
    state.page = 0;
    load();
  }, 350);

  form.search.addEventListener('input', runSearch);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.search = form.search.value.trim();
    state.status = form.status.value;
    state.reviewer = form.reviewer.value;
    state.sort = form.sort.value;
    state.page = 0;
    load();
  });
  form.status.addEventListener('change', () => form.requestSubmit());
  form.reviewer.addEventListener('change', () => form.requestSubmit());
  form.sort.addEventListener('change', () => form.requestSubmit());

  $('[data-prev]').addEventListener('click', () => {
    state.page = Math.max(0, state.page - 1);
    load();
  });
  $('[data-next]').addEventListener('click', () => {
    state.page += 1;
    load();
  });

  $('[data-select-all]').addEventListener('change', (event) => {
    const checked = event.target.checked;
    state.rows.forEach((row) => {
      if (checked) state.selected.add(row.id);
      else state.selected.delete(row.id);
    });
    $$('[data-rows] input[type="checkbox"]').forEach((box) => {
      box.checked = checked;
    });
    updateBulkBar();
  });

  $('[data-bulk-clear]').addEventListener('click', () => {
    state.selected.clear();
    updateBulkBar();
    $$('[data-rows] input[type="checkbox"]').forEach((box) => {
      box.checked = false;
    });
    $('[data-select-all]').checked = false;
  });

  $('[data-bulk-apply]').addEventListener('click', async () => {
    const toStatus = $('#bulk-status').value;
    const ids = selectedIds();
    if (!toStatus) {
      toast('Choose a status first.', { type: 'warning' });
      return;
    }
    if (!ids.length) return;
    const confirmed = window.confirm(`Change ${ids.length} application(s) to "${statusLabel(toStatus)}"?`);
    if (!confirmed) return;
    try {
      const result = await bulkUpdateStatus({ ids, toStatus });
      toast(`Updated ${result.updated} application(s).`, { type: 'success' });
      state.selected.clear();
      load();
    } catch (error) {
      toast(error?.message || 'Bulk update failed.', { type: 'error' });
    }
  });
}

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Applications' });
  renderMobileToggle();
  bindFilters();
  load();
}

boot();
