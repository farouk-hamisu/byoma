// submit-application
// The only entry point for applicant data. Validates everything server-side, moves verified
// temp uploads into their final storage location and calls the transactional
// finalize_application() database function. Rate limited and idempotent.

import { preflight, json, clientIp, readJson } from '../_shared/http.js';
import { serviceClient } from '../_shared/supabase.js';
import { mapDatabaseError, publicError, isRateLimited, rateLimited } from '../_shared/errors.js';
import { sniffImageMime, listTempFolder } from '../_shared/images.js';
import { sendEmail, renderTemplate, logNotification } from '../_shared/email.js';

const MAX_PRODUCTS = 30;
const MAX_FILES_PER_PRODUCT = 3;
const TOKEN_RE = /^[a-f0-9-]{16,64}$/;
const TEMP_FILE_RE = /^temp\/([a-f0-9-]{16,64})\/([0-9a-fA-F-]{36})\.(jpg|jpeg|png|webp)$/;

function fail(mapped) {
  return json(mapped.body, mapped.status);
}

async function verifyIdempotent(admin, idempotencyKey) {
  const { data, error } = await admin
    .from('applications')
    .select('id, reference, submitted_at, product_count, terms_version')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function sendSubmissionEmails(admin, application, payload) {
  try {
    const [{ data: prefs }, { data: settings }] = await Promise.all([
      admin.from('admin_preferences').select('*').eq('id', true).maybeSingle(),
      admin.from('application_settings').select('brand_name').eq('id', true).maybeSingle(),
    ]);
    if (!prefs) return;

    const brand = settings?.brand_name || 'Our team';
    const vars = {
      name: payload.full_name,
      email: payload.email,
      reference: application.reference,
      brand,
      products: application.product_count,
    };

    if (prefs.notify_applicant_confirmation && payload.email) {
      const result = await sendEmail({
        to: payload.email,
        subject: renderTemplate(prefs.applicant_confirmation_subject, vars),
        text: renderTemplate(prefs.applicant_confirmation_body, vars),
      });
      await logNotification(admin, {
        applicationId: application.id,
        kind: 'applicant_confirmation',
        recipient: payload.email,
        result,
      });
    }

    if (prefs.notify_admin_on_submission && prefs.admin_notification_email) {
      const body = [
        'A new partnership application was submitted.',
        '',
        `Reference: ${application.reference}`,
        `Name: ${payload.full_name}`,
        `Email: ${payload.email}`,
        `Products: ${application.product_count}`,
        `Submitted: ${new Date(application.submitted_at).toISOString()}`,
      ].join('\n');
      const result = await sendEmail({
        to: prefs.admin_notification_email,
        subject: `New application received: ${application.reference}`,
        text: body,
      });
      await logNotification(admin, {
        applicationId: application.id,
        kind: 'admin_new_application',
        recipient: prefs.admin_notification_email,
        result,
      });
    }
  } catch (error) {
    console.error('submission notifications failed', error);
  }
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
    const ip = clientIp(req);
    const { value: payload, error: readError } = await readJson(req, 500 * 1024);
    if (readError) return fail(publicError(readError));

    if (!payload || typeof payload !== 'object') {
      return fail(publicError('invalid_payload'));
    }

    const idempotencyKey = String(payload.idempotency_key || '');
    const uploadToken = String(payload.upload_token || '').toLowerCase();
    const emailKey = String(payload.email || '').toLowerCase().slice(0, 254) || 'unknown';

    // ---------------------------------------------------------- rate limiting
    try {
      await admin.rpc('bump_rate_limit', {
        p_bucket: 'submit_ip',
        p_key: ip || 'unknown',
        p_window_seconds: 600,
        p_max: 12,
      });
      await admin.rpc('bump_rate_limit', {
        p_bucket: 'submit_email',
        p_key: emailKey,
        p_window_seconds: 600,
        p_max: 6,
      });
    } catch (error) {
      if (isRateLimited(error)) return fail(rateLimited());
      console.error('rate limit check failed', error);
      return fail(publicError('service_unavailable'));
    }

    // -------------------------------------------------------------- idempotency
    if (idempotencyKey.length < 16 || idempotencyKey.length > 80 || !uploadToken || !TOKEN_RE.test(uploadToken)) {
      return fail(publicError('invalid_payload'));
    }
    const replay = await verifyIdempotent(admin, idempotencyKey);
    if (replay) {
      return json({
        ok: true,
        reference: replay.reference,
        submitted_at: replay.submitted_at,
        product_count: replay.product_count,
        terms_version: replay.terms_version,
        duplicate: true,
      });
    }

    // --------------------------------------------------------- payload checking
    const products = Array.isArray(payload.products) ? payload.products : [];
    if (products.length > MAX_PRODUCTS) return fail(publicError('max_products'));

    const tempEntries = [];
    for (const product of products) {
      if (!product || typeof product !== 'object') return fail(publicError('invalid_payload'));
      const files = Array.isArray(product.files) ? product.files : [];
      if (files.length > MAX_FILES_PER_PRODUCT) return fail(publicError('invalid_payload'));
      for (const file of files) {
        const path = String(file?.storage_path || '');
        const match = TEMP_FILE_RE.exec(path);
        if (!match || match[1].toLowerCase() !== uploadToken) {
          return fail(publicError('invalid_upload_path'));
        }
        tempEntries.push({ path, name: match[2] + '.' + match[3] });
      }
    }

    // ------------------------------------------- verify files exist + are images
    let listing = [];
    if (tempEntries.length > 0) {
      try {
        listing = await listTempFolder(admin, uploadToken);
      } catch (error) {
        console.error('temp folder listing failed', error);
        return fail(publicError('service_unavailable'));
      }
      const byName = new Map(listing.map((item) => [item.name, item]));
      for (const entry of tempEntries) {
        if (!byName.has(entry.name)) {
          const existing = await verifyIdempotent(admin, idempotencyKey);
          if (existing) {
            return json({
              ok: true,
              reference: existing.reference,
              submitted_at: existing.submitted_at,
              product_count: existing.product_count,
              terms_version: existing.terms_version,
              duplicate: true,
            });
          }
          return fail(publicError('upload_missing'));
        }
      }
    }

    const sizeByName = new Map(
      listing.map((item) => [item.name, Number(item?.metadata?.size || 0)]),
    );

    // ------------------------------------------------------ move into final path
    const applicationId = crypto.randomUUID();
    const finalPayload = structuredClone(payload);
    finalPayload.application_id = applicationId;
    finalPayload.submission_ip = ip || null;
    finalPayload.upload_token = uploadToken;
    finalPayload.products = Array.isArray(finalPayload.products) ? finalPayload.products : [];

    const movedPaths = [];
    const tempPaths = [];

    for (const product of finalPayload.products) {
      const files = Array.isArray(product.files) ? product.files : [];
      for (const file of files) {
        const tempPath = String(file.storage_path);
        const fileName = tempPath.slice(tempPath.lastIndexOf('/') + 1);
        const sniffed = await sniffImageMime(admin, tempPath);
        if (!sniffed) {
          return fail(publicError('invalid_file_type'));
        }
        const actualSize = sizeByName.get(fileName) || Number(file.file_size || 0);
        if (actualSize < 1) {
          return fail(publicError('invalid_file'));
        }

        const extension = sniffed === 'image/jpeg' ? 'jpg' : sniffed === 'image/png' ? 'png' : 'webp';
        const fileUuid = fileName.split('.')[0];
        const finalPath = `applications/${applicationId}/products/${fileUuid}.${extension}`;

        const { error: copyError } = await admin.storage.from('product-uploads').copy(tempPath, finalPath);
        if (copyError) {
          console.error('storage copy failed', copyError);
          await admin.storage.from('product-uploads').remove(movedPaths).catch(() => {});
          return fail(publicError('upload_failed'));
        }
        movedPaths.push(finalPath);
        // Keep the temp original until the database commit succeeds — if
        // finalize fails the applicant can retry without re-uploading.
        tempPaths.push(tempPath);

        file.storage_path = finalPath;
        file.mime_type = sniffed;
        file.file_size = actualSize;
      }
    }

    // ------------------------------------------------- transactional submission
    const { data, error } = await admin.rpc('finalize_application', { p: finalPayload });
    if (error) {
      // Roll back the copies; temp originals stay so a retry can succeed.
      await admin.storage.from('product-uploads').remove(movedPaths).catch(() => {});
      if (isRateLimited(error)) return fail(rateLimited());
      return fail(mapDatabaseError(error));
    }

    if (data?.duplicate) {
      await admin.storage.from('product-uploads').remove([...movedPaths, ...tempPaths]).catch(() => {});
      return json({
        ok: true,
        reference: data.reference,
        submitted_at: data.submitted_at,
        product_count: data.product_count,
        terms_version: data.terms_version,
        duplicate: true,
      });
    }

    // Committed — the temps are now permanent application files.
    await admin.storage.from('product-uploads').remove(tempPaths).catch(() => {});

    await sendSubmissionEmails(admin, data, payload);

    return json({
      ok: true,
      reference: data.reference,
      submitted_at: data.submitted_at,
      product_count: data.product_count,
      terms_version: data.terms_version,
      duplicate: false,
    });
  } catch (error) {
    console.error('submit-application failed', error);
    return fail(publicError('server_error', 500, 'Something went wrong. Please try again.'));
  }
});
