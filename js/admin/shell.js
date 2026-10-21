// Shared admin chrome: sidebar navigation, header, active state, sign out.

import { $, el, clearNode } from '../utils/dom.js';
import { signOut } from './api.js';

const NAV = [
  { href: '/admin/', label: 'Dashboard', icon: '▤', match: /^\/admin\/(index\.html)?$/ },
  { href: '/admin/applications.html', label: 'Applications', icon: '☰', match: /applications\.html|application\.html/ },
  { href: '/admin/terms.html', label: 'Terms', icon: '§', match: /terms\.html/ },
  { href: '/admin/form-fields.html', label: 'Form builder', icon: '✎', match: /form-fields\.html/ },
  { href: '/admin/settings.html', label: 'Settings', icon: '⚙', match: /settings\.html/ },
  { href: '/admin/team.html', label: 'Team', icon: '☺', match: /team\.html/ },
  { href: '/admin/audit.html', label: 'Audit log', icon: '≡', match: /audit\.html/ },
];

export function renderShell({ profile, active = null } = {}) {
  const sidebar = $('[data-admin-sidebar]');
  const header = $('[data-admin-header]');
  if (!sidebar) return;

  const path = window.location.pathname;

  clearNode(sidebar);
  const brand = el('a', { class: 'admin-brand', href: '/admin/' }, [
    el('img', {
      class: 'admin-brand__logo',
      src: '/assets/Byomalogo.avif',
      alt: '',
      width: '300',
      height: '61',
    }),
    el('span', { class: 'admin-brand__name', text: 'Admin' }),
  ]);
  sidebar.append(brand);

  const nav = el('nav', { class: 'admin-nav', 'aria-label': 'Admin' });
  for (const item of NAV) {
    const isActive = active ? active === item.label : item.match.test(path);
    const link = el('a', {
      class: `admin-nav__link${isActive ? ' is-active' : ''}`,
      href: item.href,
      text: item.label,
    });
    if (isActive) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  sidebar.append(nav);

  const foot = el('div', { class: 'admin-sidebar__foot' }, [
    el('a', { class: 'admin-nav__link admin-nav__link--muted', href: '/', text: 'View public site' }),
  ]);
  sidebar.append(foot);

  if (header) {
    clearNode(header);
    // Mobile hamburger — rendered here (not in static HTML) because this
    // function rebuilds the header and would otherwise wipe any static button.
    header.append(
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        'data-sidebar-toggle': true,
        'aria-expanded': 'false',
        'aria-label': 'Open navigation menu',
        text: '☰ Menu',
      }),
    );
    header.append(el('span', { class: 'admin-header__page', text: active || '' }));
    const right = el('div', { class: 'admin-header__right' });
    if (profile) {
      right.append(
        el('span', {
          class: 'admin-header__user',
          text: profile.full_name || profile.email || 'Admin',
        }),
      );
    }
    right.append(
      el('button', {
        type: 'button',
        class: 'btn btn--secondary btn--sm',
        text: 'Sign out',
        onClick: async () => {
          await signOut();
          window.location.href = '/admin/login.html';
        },
      }),
    );
    header.append(right);
  }
}

export function renderMobileToggle() {
  const toggle = $('[data-sidebar-toggle]');
  const sidebar = $('[data-admin-sidebar]');
  if (!toggle || !sidebar) return;

  // Backdrop behind the open drawer; clicking it closes the sidebar.
  let backdrop = document.querySelector('.admin-sidebar-backdrop');
  if (!backdrop) {
    backdrop = el('div', { class: 'admin-sidebar-backdrop', 'aria-hidden': 'true' });
    document.body.append(backdrop);
  }

  const setOpen = (open) => {
    document.body.classList.toggle('admin-sidebar-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
  };

  toggle.addEventListener('click', () => {
    setOpen(!document.body.classList.contains('admin-sidebar-open'));
  });
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  // Navigating to a section closes the drawer (and resets its state).
  sidebar.addEventListener('click', (event) => {
    const link = event.target?.closest?.('a[href]');
    if (link) setOpen(false);
  });
}
