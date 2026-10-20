// admin-notify
// Optional email notifications triggered by administrators (status changes, published terms).
// The caller must be a valid, active administrator; recipients and templates are always
// re-read server-side so client input cannot direct mail flow.

import { preflight, json, clientIp, readJson } from '../_shared/http.js';
import { serviceClient } from '../_shared/supabase.js';
import { publicError, isRateLimited, rateLimited } from '../_shared/errors.js';
import { sendEmail, renderTemplate, logNotification } from '../_shared/email.js';

function fail(mapped) {
  return json(mapped.body, mapped.status);
}

async function requireAdmin(req, admin) {
  const header = req.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await admin
    .from('admin_profiles')
    .select('id, email, full_name, is_active')
    .eq('id', data.user.id)
    .maybeSingle();
  return profile && profile.is_active ? profile : null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail(publicError('method_not_allowed'));

  let admin;
  try {
    admin = serviceClient();
  } catch {
    return fail(publicError('missing_env'));
  }

  try {
    const adminProfile = await requireAdmin(req, admin);
    if (!adminProfile) return fail(publicError('forbidden'));

    const ip = clientIp(req);
    try {
      await admin.rpc('bump_rate_limit', {
        p_bucket: 'admin_notify',
        p_key: adminProfile.id,
        p_window_seconds: 600,
        p_max: 60,
      });
    } catch (error) {
      if (isRateLimited(error)) return fail(rateLimited());
      console.error('rate limit check failed', error);
      return fail(publicError('service_unavailable'));
    }

    const { value, error: readError } = await readJson(req, 16 * 1024);
    if (readError) return fail(publicError(readError));

    const type = String(value?.type || '');
    const { data: prefs } = await admin
      .from('admin_preferences')
      .select('*')
      .eq('id', true)
      .maybeSingle();
    const { data: settings } = await admin
      .from('application_settings')
      .select('brand_name')
      .eq('id', true)
      .maybeSingle();
    const brand = settings?.brand_name || 'Our team';

    if (type === 'status_change') {
      if (!prefs?.notify_status_changes) {
        return json({ sent: 0, skipped: 'disabled' });
      }
      const applicationId = String(value?.applicationId || '');
      if (!applicationId) return fail(publicError('invalid_payload'));

      const { data: application, error: appError } = await admin
        .from('applications')
        .select('id, reference, full_name, email, status')
        .eq('id', applicationId)
        .maybeSingle();
      if (appError) throw appError;
      if (!application) return fail(publicError('not_found'));

      const statusLabels = {
        new: 'New',
        under_review: 'Under Review',
        approved: 'Approved',
        rejected: 'Rejected',
        more_info: 'More Information Required',
      };
      const vars = {
        name: application.full_name,
        reference: application.reference,
        status: statusLabels[application.status] || application.status,
        reason: String(value?.reason || '').slice(0, 500),
        brand,
      };

      const result = await sendEmail({
        to: application.email,
        subject: renderTemplate(prefs.status_subject, vars),
        text: renderTemplate(prefs.status_body, vars),
      });
      await logNotification(admin, {
        applicationId: application.id,
        kind: `status_${application.status}`,
        recipient: application.email,
        result,
      });
      return json({ sent: result.status === 'sent' ? 1 : 0, status: result.status });
    }

    if (type === 'terms_published') {
      if (!prefs?.notify_terms_published) {
        return json({ sent: 0, skipped: 'disabled' });
      }
      const termsId = value?.termsId ? String(value.termsId) : null;
      let query = admin
        .from('terms_documents')
        .select('id, title, version, published_at');
      if (termsId) {
        query = query.eq('id', termsId);
      } else {
        query = query.eq('status', 'published').order('published_at', { ascending: false }).limit(1);
      }
      const { data: termsRow, error: termsError } = await query.maybeSingle();
      if (termsError) throw termsError;
      if (!termsRow) return fail(publicError('not_found'));

      const recipients = [];
      if (prefs.admin_notification_email) recipients.push(prefs.admin_notification_email);
      if (recipients.length === 0) {
        const { data: admins } = await admin
          .from('admin_profiles')
          .select('email')
          .eq('is_active', true);
        for (const row of admins || []) {
          if (row.email) recipients.push(row.email);
        }
      }

      let sent = 0;
      const subject = `New Terms & Conditions published: ${termsRow.version}`;
      const body = [
        `A new Terms & Conditions version is now live: ${termsRow.version}`,
        '',
        `Title: ${termsRow.title}`,
        `Published: ${termsRow.published_at ? new Date(termsRow.published_at).toISOString() : 'unknown'}`,
        '',
        'Applicants will be required to accept this version before submitting.',
      ].join('\n');

      for (const recipient of recipients) {
        const result = await sendEmail({ to: recipient, subject, text: body });
        if (result.status === 'sent') sent += 1;
        await logNotification(admin, { applicationId: null, kind: 'terms_published', recipient, result });
      }
      return json({ sent, recipients: recipients.length });
    }

    return fail(publicError('invalid_payload'));
  } catch (error) {
    console.error('admin-notify failed', error);
    return fail(publicError('server_error', 500, 'Something went wrong. Please try again.'));
  }
});
