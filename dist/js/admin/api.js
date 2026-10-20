// Admin data access: session-aware client, RPC helpers, storage signed URLs.

import { getClient, EdgeError, proxiedUrl } from '../supabase.js';

export class AdminApiError extends Error {
  constructor({ code, message, status }) {
    super(message || 'Something went wrong.');
    this.name = 'AdminApiError';
    this.code = code || 'server_error';
    this.status = status || 500;
  }
}

const PUBLIC_RPC_MESSAGE = {
  forbidden: 'You do not have permission to do that.',
  not_found: 'That record no longer exists.',
  invalid_payload: 'The request was invalid. Please check and try again.',
  version_exists: 'A terms document with that version already exists.',
  is_current: 'This is the current published version. Publish another version first.',
  terms_in_use: 'Applications have accepted this version — it cannot be deleted.',
  not_current: 'Only the current version can be unpublished.',
  invalid_reviewer: 'That reviewer is not an active admin.',
  unsafe_content: 'That value contains content that is not allowed.',
};

function mapRpcError(error) {
  const message = String(error?.message || '');
  const code =
    Object.keys(PUBLIC_RPC_MESSAGE).find((key) => message.includes(key)) ||
    (message.includes('invalid_setting') ? 'invalid_setting' : 'server_error');
  return new AdminApiError({
    code,
    message: PUBLIC_RPC_MESSAGE[code] || 'Something went wrong. Please try again.',
    status: error?.status || 500,
  });
}

export async function getSession() {
  const supabase = getClient();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw mapRpcError(error);
  return data?.session || null;
}

export async function getUser() {
  const supabase = getClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) throw mapRpcError(error);
  return data?.user || null;
}

export async function signIn({ email, password }) {
  const supabase = getClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new AdminApiError({
      code: 'invalid_credentials',
      message: 'Incorrect email or password.',
      status: 401,
    });
  }
  return data;
}

export async function signOut() {
  const supabase = getClient();
  await supabase.auth.signOut().catch(() => {});
}

export async function getProfile() {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('admin_profiles')
    .select('*')
    .eq('id', (await getUser())?.id)
    .maybeSingle();
  if (error) throw mapRpcError(error);
  return data;
}

async function rpc(name, payload) {
  const supabase = getClient();
  const { data, error } = await supabase.rpc(name, { p: payload });
  if (error) throw mapRpcError(error);
  return data;
}

/* ------------------------------------------------------------- applications */

export async function listApplications({
  status = '',
  search = '',
  reviewer = '',
  page = 0,
  pageSize = 25,
  sort = 'submitted_at.desc',
} = {}) {
  const supabase = getClient();
  const [column, direction] = sort.split('.');
  let query = supabase
    .from('applications')
    .select('id, reference, full_name, email, country, instagram_handle, tiktok_handle, status, product_count, submitted_at, first_response_at, reviewer_id, terms_version', { count: 'exact' })
    .order(column, { ascending: direction !== 'desc' })
    .range(page * pageSize, page * pageSize + pageSize - 1);

  if (status) query = query.eq('status', status);
  if (reviewer) {
    if (reviewer === 'none') query = query.is('reviewer_id', null);
    else query = query.eq('reviewer_id', reviewer);
  }
  if (search) {
    const term = search.trim();
    query = query.or(`reference.ilike.%${term}%,full_name.ilike.%${term}%,email.ilike.%${term}%,instagram_handle.ilike.%${term}%,tiktok_handle.ilike.%${term}%`);
  }

  const { data, error, count } = await query;
  if (error) throw mapRpcError(error);
  return { rows: data || [], total: count || 0 };
}

export async function getApplication(id) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('applications')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw mapRpcError(error);
  if (!data) throw new AdminApiError({ code: 'not_found', message: PUBLIC_RPC_MESSAGE.not_found });
  return data;
}

export async function getApplicationProducts(applicationId) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('application_products')
    .select('*, application_product_files(*)')
    .eq('application_id', applicationId)
    .order('position', { ascending: true });
  if (error) throw mapRpcError(error);
  return data || [];
}

export async function getApplicationNotes(applicationId) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('application_notes')
    .select('*, admin_profiles(full_name, email)')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false });
  if (error) throw mapRpcError(error);
  return data || [];
}

export async function getStatusHistory(applicationId) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('application_status_history')
    .select('*, admin_profiles(full_name)')
    .eq('application_id', applicationId)
    .order('changed_at', { ascending: false });
  if (error) throw mapRpcError(error);
  return data || [];
}

export async function getApplicationDocuments(applicationId) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('application_documents')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false });
  if (error) throw mapRpcError(error);
  return data || [];
}

export async function updateApplicationStatus({ applicationId, toStatus, reason = '' }) {
  return rpc('update_application_status', { application_id: applicationId, to_status: toStatus, reason });
}

export async function bulkUpdateStatus({ ids, toStatus, reason = '' }) {
  return rpc('bulk_update_application_status', { ids, to_status: toStatus, reason });
}

export async function assignReviewer({ applicationId, reviewerId }) {
  return rpc('assign_reviewer', { application_id: applicationId, reviewer_id: reviewerId });
}

export async function addNote({ applicationId, body }) {
  return rpc('add_application_note', { application_id: applicationId, body });
}

export async function attachDocument({ applicationId, storagePath, label, mimeType, fileSize, sha256 }) {
  return rpc('attach_application_document', {
    application_id: applicationId,
    storage_path: storagePath,
    label,
    mime_type: mimeType,
    file_size: fileSize,
    sha256,
  });
}

export async function deleteDocument({ id }) {
  return rpc('delete_application_document', { id });
}

export async function listAdmins({ activeOnly = true } = {}) {
  const supabase = getClient();
  let query = supabase.from('admin_profiles').select('id, full_name, email, is_admin, is_active').order('full_name');
  if (activeOnly) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw mapRpcError(error);
  return data || [];
}

/* ------------------------------------------------------------------ settings */

export async function getSettings() {
  const supabase = getClient();
  const { data, error } = await supabase.from('application_settings').select('*').eq('id', true).maybeSingle();
  if (error) throw mapRpcError(error);
  return data || {};
}

export async function saveSettings(patch) {
  return rpc('save_application_settings', patch);
}

export async function getFormFields() {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('form_field_settings')
    .select('*')
    .order('step', { ascending: true })
    .order('position', { ascending: true });
  if (error) throw mapRpcError(error);
  return data || [];
}

export async function saveFormFields(items) {
  return rpc('save_form_fields', items);
}

export async function getPreferences() {
  const supabase = getClient();
  const { data, error } = await supabase.from('admin_preferences').select('*').eq('id', true).maybeSingle();
  if (error) throw mapRpcError(error);
  return data || {};
}

export async function savePreferences(patch) {
  return rpc('save_admin_preferences', patch);
}

export async function overviewStats({ days = 30 } = {}) {
  return rpc('admin_overview_stats', { days });
}

export async function listAuditLogs({ limit = 100 } = {}) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('admin_audit_logs')
    .select('*, admin_profiles(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw mapRpcError(error);
  return data || [];
}

/* --------------------------------------------------------------------- terms */

export async function listTerms() {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('terms_documents')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw mapRpcError(error);
  return data || [];
}

export async function registerTerms({ title, description, version, storagePath, fileSize, sha256 }) {
  return rpc('register_terms_document', {
    title,
    description,
    version,
    storage_path: storagePath,
    file_size: fileSize,
    sha256,
  });
}

export async function publishTerms({ id }) {
  return rpc('publish_terms', { id });
}

export async function unpublishTerms({ id }) {
  return rpc('unpublish_terms', { id });
}

export async function deleteTerms({ id }) {
  return rpc('delete_terms_document', { id });
}

/* ------------------------------------------------------------------- storage */

export async function createSignedUpload(bucket, path, expiresIn = 3600) {
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
  if (error) {
    throw new AdminApiError({ code: 'upload_failed', message: 'Could not prepare the upload. Please try again.' });
  }
  return data; // { signedUrl, token }
}

export async function uploadSigned({ bucket, path, token, file }) {
  const supabase = getClient();
  const { error } = await supabase.storage.from(bucket).uploadToSignedUrl(path, token, file, {
    upsert: false,
    contentType: file.type || undefined,
  });
  if (error) {
    throw new AdminApiError({ code: 'upload_failed', message: 'The upload failed. Please try again.' });
  }
}

export async function createSignedUrl(bucket, path, expiresIn = 3600) {
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error) {
    throw new AdminApiError({ code: 'signed_url_failed', message: 'Could not create a download link.' });
  }
  // Route through the same-origin proxy when one is active so images load even
  // if the browser blocks direct *.supabase.co requests.
  return proxiedUrl(data?.signedUrl || '');
}

export async function removeObjects(bucket, paths) {
  const supabase = getClient();
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) {
    throw new AdminApiError({ code: 'remove_failed', message: 'Could not delete the file.' });
  }
}

export async function sha256OfFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

export { EdgeError };
