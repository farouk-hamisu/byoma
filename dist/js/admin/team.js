// Team page: read-only list of admin profiles.

import { $, el, clearNode } from '../utils/dom.js';
import { requireAdmin } from './auth.js';
import { renderShell, renderMobileToggle } from './shell.js';
import { listAdmins } from './api.js';

async function boot() {
  const auth = await requireAdmin();
  if (!auth) return;
  renderShell({ profile: auth.profile, active: 'Team' });
  renderMobileToggle();

  const tbody = $('[data-rows]');
  try {
    const admins = await listAdmins({ activeOnly: false });
    clearNode(tbody);
    if (!admins.length) {
      tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '4', text: 'No admin accounts found.' })]));
      return;
    }
    for (const admin of admins) {
      tbody.append(
        el('tr', {}, [
          el('td', { text: admin.full_name || '—' }),
          el('td', { text: admin.email || '—' }),
          el('td', {}, [el('span', { class: 'badge badge--neutral', text: admin.is_admin ? 'Admin' : 'Staff' })]),
          el('td', {}, [
            el('span', {
              class: `badge ${admin.is_active ? 'badge--approved' : 'badge--rejected'}`,
              text: admin.is_active ? 'Active' : 'Disabled',
            }),
          ]),
        ]),
      );
    }
  } catch (error) {
    clearNode(tbody);
    tbody.append(el('tr', {}, [el('td', { class: 'empty', colspan: '4', text: error?.message || 'Could not load the team.' })]));
  }
}

boot();
