// Session guard for every admin page except login.

import { getSession, getUser, getProfile, signOut } from './api.js';

const GUARDED_FLAG = 'data-admin-guard';

export async function requireAdmin({ redirect = '/admin/login.html' } = {}) {
  document.body.setAttribute(GUARDED_FLAG, 'pending');
  try {
    const session = await getSession();
    if (!session) {
      window.location.replace(redirect);
      return null;
    }
    const user = await getUser();
    if (!user) {
      window.location.replace(redirect);
      return null;
    }
    const profile = await getProfile().catch(() => null);
    if (!profile || !profile.is_active) {
      await signOut();
      window.location.replace(`${redirect}?error=inactive`);
      return null;
    }
    document.body.setAttribute(GUARDED_FLAG, 'ok');
    return { session, user, profile };
  } catch (error) {
    console.error('admin guard failed', error);
    document.body.setAttribute(GUARDED_FLAG, 'error');
    return null;
  }
}

export async function currentProfile() {
  try {
    return await getProfile();
  } catch {
    return null;
  }
}
