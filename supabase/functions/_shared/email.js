// Optional transactional email support.
// Providers are configured through environment variables only — never exposed to the browser.
// Email failures are logged and never affect application submission.

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

export function renderTemplate(template, vars = {}) {
  let out = String(template ?? '');
  out = out.split('{{newline}}').join('\n');
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  }
  out = out.replace(/\{\{[a-zA-Z0-9_]+\}\}/g, '');
  return out;
}

export function textToHtml(text) {
  const escaped = escapeHtml(text);
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split('\n').join('<br>')}</p>`)
    .join('\n');
}

export async function sendEmail({ to, subject, text }) {
  const provider = (Deno.env.get('EMAIL_PROVIDER') || 'none').toLowerCase();

  if (!to || !subject) {
    return { status: 'skipped', reason: 'missing_recipient' };
  }
  if (provider === 'none') {
    return { status: 'skipped', reason: 'provider_not_configured' };
  }

  const html = textToHtml(text);

  try {
    if (provider === 'resend') {
      const apiKey = Deno.env.get('EMAIL_API_KEY');
      const from = Deno.env.get('EMAIL_FROM');
      if (!apiKey || !from) {
        return { status: 'skipped', reason: 'provider_not_configured' };
      }
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { status: 'failed', error: `resend_${response.status}: ${detail.slice(0, 300)}` };
      }
      const data = await response.json().catch(() => ({}));
      return { status: 'sent', providerMessageId: String(data.id || '') };
    }

    if (provider === 'webhook') {
      const webhookUrl = Deno.env.get('EMAIL_WEBHOOK_URL');
      if (!webhookUrl) {
        return { status: 'skipped', reason: 'provider_not_configured' };
      }
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text, html }),
      });
      if (!response.ok) {
        return { status: 'failed', error: `webhook_${response.status}` };
      }
      return { status: 'sent', providerMessageId: '' };
    }

    return { status: 'skipped', reason: 'unknown_provider' };
  } catch (error) {
    return { status: 'failed', error: String(error?.message || error).slice(0, 500) };
  }
}

export async function logNotification(client, { applicationId = null, kind, recipient = '', result }) {
  try {
    await client.from('notification_log').insert({
      application_id: applicationId,
      kind,
      recipient: String(recipient || '').slice(0, 254),
      status: result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'skipped',
      provider_message_id: String(result.providerMessageId || '').slice(0, 200),
      error: String(result.reason || result.error || '').slice(0, 1000),
    });
  } catch (error) {
    console.error('notification_log insert failed', error);
  }
}
