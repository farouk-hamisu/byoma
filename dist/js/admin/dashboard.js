// Dashboard: stats, daily volume chart, recent applications.

import { $, el, clearNode } from '../utils/dom.js';
import { formatDateTime, statusLabel } from '../utils/format.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import { overviewStats } from './api.js';

function statCard(label, value, hint = '') {
  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-card__label', text: label }),
    el('p', { class: 'stat-card__value', text: String(value ?? '—') }),
    hint ? el('p', { class: 'stat-card__hint', text: hint }) : null,
  ].filter(Boolean));
}

function renderStats(stats) {
  const wrap = $('[data-stats]');
  clearNode(wrap);
  const byStatus = stats.by_status || {};
  wrap.append(
    statCard('Total', stats.total),
    statCard(`Last ${stats.period_days} days`, stats.period_count),
    statCard('Awaiting review', (byStatus.new || 0) + (byStatus.under_review || 0)),
    statCard('Approved', byStatus.approved || 0),
    statCard('Rejected', byStatus.rejected || 0),
    statCard(
      'Avg. first response',
      stats.avg_review_minutes != null ? `${stats.avg_review_minutes} min` : '—',
      `${stats.reviewed_count || 0} reviewed`,
    ),
  );
}

function renderChart(daily) {
  if (!Array.isArray(daily) || !daily.length) return;
  const section = $('[data-chart-section]');
  const chart = $('[data-chart]');
  const label = $('[data-chart-label]');
  section.hidden = false;
  clearNode(chart);
  const max = Math.max(1, ...daily.map((d) => d.count));
  for (const day of daily) {
    const col = el('div', {
      class: 'bars__col',
      style: `height:${Math.max(4, Math.round((day.count / max) * 100))}%`,
      title: `${day.day}: ${day.count}`,
    });
    chart.append(col);
  }
  if (label) {
    label.textContent = `${daily[0].day} → ${daily[daily.length - 1].day} · peak ${max}/day`;
  }
}

function renderRecent(rows) {
  const tbody = $('[data-recent]');
  clearNode(tbody);
  if (!rows.length) {
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '5', text: 'No applications yet.' })]));
    return;
  }
  for (const row of rows) {
    const tr = el('tr');
    const refCell = el('td');
    refCell.append(
      el('a', { href: `/admin/application.html?id=${row.id}`, text: row.reference || '—' }),
    );
    tr.append(
      refCell,
      el('td', { text: row.full_name || '—' }),
      el('td', {}, [el('span', { class: `badge badge--${row.status}`, text: statusLabel(row.status) })]),
      el('td', { text: String(row.product_count ?? 0) }),
      el('td', { text: formatDateTime(row.submitted_at) }),
    );
    tbody.append(tr);
  }
}

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Dashboard' });
  renderMobileToggle();

  try {
    const stats = await overviewStats({ days: 30 });
    renderStats(stats);
    renderChart(stats.daily);
    renderRecent(stats.recent || []);
  } catch (error) {
    console.error('dashboard load failed', error);
    const tbody = $('[data-recent]');
    if (tbody) {
      clearNode(tbody);
      tbody.append(
        el('tr', {}, [
          el('td', { class: 'empty', colspan: '5', text: error?.message || 'Could not load statistics.' }),
        ]),
      );
    }
  }
}

boot();
