-- 0004: Row Level Security
-- Model:
--   * anonymous users: read-only access to public-safe configuration (branding + form fields)
--   * authenticated admins: read access to all workspace data
--   * writes to protected tables: only through security definer functions / service role

alter table public.admin_profiles enable row level security;
alter table public.applications enable row level security;
alter table public.application_products enable row level security;
alter table public.application_product_files enable row level security;
alter table public.application_documents enable row level security;
alter table public.application_notes enable row level security;
alter table public.application_status_history enable row level security;
alter table public.terms_documents enable row level security;
alter table public.application_settings enable row level security;
alter table public.form_field_settings enable row level security;
alter table public.admin_preferences enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.rate_limits enable row level security;
alter table public.notification_log enable row level security;

-- ---------------------------------------------------------------------------
-- admin_profiles
-- ---------------------------------------------------------------------------
drop policy if exists admin_profiles_select on public.admin_profiles;
create policy admin_profiles_select on public.admin_profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists admin_profiles_update_own on public.admin_profiles;
create policy admin_profiles_update_own on public.admin_profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Applicant data: admins read, everything else happens server-side
-- ---------------------------------------------------------------------------
drop policy if exists applications_admin_select on public.applications;
create policy applications_admin_select on public.applications
  for select to authenticated using (public.is_admin());

drop policy if exists application_products_admin_select on public.application_products;
create policy application_products_admin_select on public.application_products
  for select to authenticated using (public.is_admin());

drop policy if exists application_product_files_admin_select on public.application_product_files;
create policy application_product_files_admin_select on public.application_product_files
  for select to authenticated using (public.is_admin());

drop policy if exists application_documents_admin_select on public.application_documents;
create policy application_documents_admin_select on public.application_documents
  for select to authenticated using (public.is_admin());

drop policy if exists application_notes_admin_select on public.application_notes;
create policy application_notes_admin_select on public.application_notes
  for select to authenticated using (public.is_admin());

drop policy if exists application_status_history_admin_select on public.application_status_history;
create policy application_status_history_admin_select on public.application_status_history
  for select to authenticated using (public.is_admin());

drop policy if exists notification_log_admin_select on public.notification_log;
create policy notification_log_admin_select on public.notification_log
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Terms documents
-- ---------------------------------------------------------------------------
drop policy if exists terms_documents_admin_select on public.terms_documents;
create policy terms_documents_admin_select on public.terms_documents
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Public-safe configuration
-- ---------------------------------------------------------------------------
drop policy if exists application_settings_public_select on public.application_settings;
create policy application_settings_public_select on public.application_settings
  for select using (true);

drop policy if exists form_field_settings_public_select on public.form_field_settings;
create policy form_field_settings_public_select on public.form_field_settings
  for select using (true);

-- ---------------------------------------------------------------------------
-- Privileged configuration / audit trail
-- ---------------------------------------------------------------------------
drop policy if exists admin_preferences_admin_select on public.admin_preferences;
create policy admin_preferences_admin_select on public.admin_preferences
  for select to authenticated using (public.is_admin());

drop policy if exists admin_audit_logs_admin_select on public.admin_audit_logs;
create policy admin_audit_logs_admin_select on public.admin_audit_logs
  for select to authenticated using (public.is_admin());

-- rate_limits intentionally has no policies (edge functions use the service role)

-- ---------------------------------------------------------------------------
-- Sequences: applicant-facing roles never touch them
-- ---------------------------------------------------------------------------
revoke usage on all sequences in schema public from anon, authenticated;
