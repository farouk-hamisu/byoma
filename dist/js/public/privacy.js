// Privacy page: branding only.

import { loadPublicSettings } from './api.js';
import { applyBranding, pageTitle } from './branding.js';
import { applyShopLinks } from './shop.js';

loadPublicSettings()
  .then(({ settings }) => {
    applyBranding(settings);
    applyShopLinks(settings);
    pageTitle('Privacy Policy', settings);
  })
  .catch((error) => {
    console.error('privacy boot failed', error);
    document.body.dataset.bootstrapped = 'partial';
  });
