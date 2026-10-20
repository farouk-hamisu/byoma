// Audit log: recent administrative actions.

import { $, el, clearNode } from '../utils/dom.js';
import { formatDateTime } from '../utils/format.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import { listAuditLogs } from './api.js';

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Audit log' });
  renderMobileToggle();

  const tbody = $('[data-rows]');
  try {
    const rows = await listAuditLogs({ limit: 200 });
    clearNode(tbody);
    if (!rows.length) {
      tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '5', text: 'No audit entries yet.' })]));
      return;
    }
    for (const row of rows) {
      const who = row.admin_profiles?.full_name || row.admin_profiles?.email || row.admin_id || '—';
      let details = '';
      try {
        details = row.metadata ? JSON.stringify(row.metadata) : '';
      } catch {
        details = '';
      }
      tbody.append(
        el('tr', {}, [
          el('td', { text: formatDateTime(row.created_at) }),
          el('td', { text: who }),
          el('td', { text: row.action || '—' }),
          el('td', { text: row.entity_type ? `${row.entity_type}${row.entity_id ? ` ${row.entity_id.slice(0, 8)}` : ''}` : '—' }),
          el('td', {
            text: details.length > 120 ? `${details.slice(0, 120)}…` : details,
            title: details,
          }),
        ]),
      );
    }
  } catch (error) {
    clearNode(tbody);
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '5', text: error?.message || 'Could not load the audit log.' })]));
  }
}

boot();
