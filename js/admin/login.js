// Admin login: password sign-in, already-authed redirect, friendly errors.

import { $ } from '../utils/dom.js';
import { signIn, getSession, getProfile } from './api.js';

const form = $('[data-login-form]');
const errorBox = $('[data-login-error]');
const submitButton = $('[data-login-submit]');

function showError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  if (!errorBox) return;
  errorBox.hidden = true;
  errorBox.textContent = '';
}

async function redirectIfAuthed() {
  try {
    const session = await getSession();
    if (!session) return;
    const profile = await getProfile().catch(() => null);
    if (profile?.is_active) {
      window.location.replace('/admin/');
    }
  } catch {
    /* not signed in */
  }
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const email = String(form.email.value || '').trim();
  const password = String(form.password.value || '');
  if (!email || !password) {
    showError('Enter your email and password.');
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = 'Signing in…';

  try {
    await signIn({ email, password });
    const profile = await getProfile().catch(() => null);
    if (!profile || !profile.is_active) {
      showError('This account is not active. Contact an administrator.');
      return;
    }
    window.location.replace('/admin/');
  } catch (error) {
    showError(error?.message || 'Sign in failed. Please try again.');
    submitButton.disabled = false;
    submitButton.textContent = 'Sign in';
  }
});

// surface ?error=inactive from the guard
const params = new URLSearchParams(window.location.search);
if (params.get('error') === 'inactive') {
  showError('Your account is no longer active. Contact an administrator.');
}

redirectIfAuthed();
