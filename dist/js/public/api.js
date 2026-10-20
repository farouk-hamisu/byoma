// Public data access: settings, terms metadata and the submission pipeline.

import { getClient, invokeEdge, EdgeError, ensureConnection } from '../supabase.js';

export async function loadPublicSettings() {
  await ensureConnection();
  const supabase = getClient();
  const [settingsResult, fieldsResult] = await Promise.all([
    supabase.from('application_settings').select('*').eq('id', true).maybeSingle(),
    supabase
      .from('form_field_settings')
      .select('*')
      .order('position', { ascending: true })
      .order('step', { ascending: true }),
  ]);

  if (settingsResult.error) {
    const unreachable = !settingsResult.status;
    throw new EdgeError({
      code: unreachable ? 'network_error' : 'settings_load_failed',
      message: unreachable
        ? 'We could not reach the server. Check your connection and try again.'
        : 'We could not load the application settings. Please try again.',
      status: settingsResult.status || 0,
    });
  }
  if (fieldsResult.error) {
    const unreachable = !fieldsResult.status;
    throw new EdgeError({
      code: unreachable ? 'network_error' : 'fields_load_failed',
      message: unreachable
        ? 'We could not reach the server. Check your connection and try again.'
        : 'We could not load the application form. Please try again.',
      status: fieldsResult.status || 0,
    });
  }

  return {
    settings: settingsResult.data || {},
    fields: fieldsResult.data || [],
  };
}

// Metadata for the currently published Terms & Conditions.
export async function getTermsMetadata() {
  return invokeEdge('terms-current', { method: 'GET' });
}

// Metadata + short-lived signed URL for the PDF viewer.
export async function getTermsDocumentUrl() {
  return invokeEdge('terms-current', { method: 'POST', body: { withUrl: true } });
}

export async function prepareUpload({ contentType, uploadToken = null }) {
  return invokeEdge('prepare-upload', {
    body: { contentType, uploadToken: uploadToken || undefined },
  });
}

export async function uploadToSignedUrl({ path, token, signedUrl, file, contentType, onStateChange }) {
  const type = contentType || file.type;
  onStateChange?.('uploading');

  // Upload through the SDK, which sends the signed token as multipart form
  // data to the storage upload endpoint. A raw-body POST to the signed URL is
  // NOT an upload — the storage API treats that request as "mint another
  // signed URL", answers 200, and stores nothing. (That false success is what
  // previously left submissions failing with upload_missing.)
  const { error } = await getClient().storage.from('product-uploads').uploadToSignedUrl(path, token, file, {
    upsert: false,
    contentType: type,
  });
  if (error) {
    onStateChange?.('error');
    throw new EdgeError({
      code: 'upload_failed',
      message: 'The image upload failed. Please try again.',
      status: 400,
    });
  }
  onStateChange?.('ready');
}

export async function getDraftFileUrls(uploadToken) {
  return invokeEdge('draft-file-url', { body: { uploadToken } });
}

export async function submitApplication(payload) {
  return invokeEdge('submit-application', { body: payload });
}
