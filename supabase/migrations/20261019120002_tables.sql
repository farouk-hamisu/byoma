-- 0002: Core schema
-- All applicant data is written through server-side workflows (edge functions / security definer
-- functions). Anonymous clients never receive insert/update rights that RLS would allow.

create sequence if not exists public.application_reference_seq start 1;

-- ---------------------------------------------------------------------------
-- Administrators (linked to Supabase Auth)
-- ---------------------------------------------------------------------------
create table if not exists public.admin_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name   text not null default '',
  role        text not null default 'reviewer' check (role in ('owner', 'admin', 'reviewer')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Immutable Terms & Conditions versions
-- ---------------------------------------------------------------------------
create table if not exists public.terms_documents (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(title) between 1 and 200),
  description   text not null default '' check (char_length(description) <= 2000),
  version       text not null unique check (version ~* '^[A-Za-z0-9._-]{1,40}$'),
  storage_path  text not null unique check (storage_path like 'terms-docs/%'),
  file_size     bigint not null check (file_size > 0),
  mime_type     text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  sha256        text check (sha256 is null or sha256 ~* '^[0-9a-f]{64}$'),
  status        text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  is_current    boolean not null default false,
  uploaded_by   uuid references public.admin_profiles (id) on delete set null,
  uploaded_at   timestamptz not null default now(),
  published_by  uuid references public.admin_profiles (id) on delete set null,
  published_at  timestamptz,
  unpublished_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint terms_current_is_published check (is_current = false or status = 'published')
);
create unique index if not exists terms_documents_single_current
  on public.terms_documents (is_current) where is_current;
create index if not exists terms_documents_status_idx on public.terms_documents (status, published_at desc);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------
create table if not exists public.applications (
  id                  uuid primary key default gen_random_uuid(),
  reference           text not null unique,
  idempotency_key     text not null unique check (char_length(idempotency_key) between 16 and 80),

  full_name           text not null check (char_length(full_name) between 1 and 200),
  email               text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone               text not null default '' check (char_length(phone) <= 40),
  country             text not null default '' check (char_length(country) <= 120),
  region              text not null default '' check (char_length(region) <= 120),

  address_street      text not null default '' check (char_length(address_street) <= 300),
  address_line2       text not null default '' check (char_length(address_line2) <= 300),
  address_city        text not null default '' check (char_length(address_city) <= 200),
  address_region      text not null default '' check (char_length(address_region) <= 200),
  address_postal_code text not null default '' check (char_length(address_postal_code) <= 40),
  address_country     text not null default '' check (char_length(address_country) <= 120),

  instagram_handle    text not null default '' check (char_length(instagram_handle) <= 100),
  tiktok_handle       text not null default '' check (char_length(tiktok_handle) <= 100),
  other_handles       jsonb not null default '[]'::jsonb check (jsonb_typeof(other_handles) = 'array'),
  portfolio_url       text check (portfolio_url is null or char_length(portfolio_url) <= 500),
  budget              text not null default '' check (char_length(budget) <= 120),
  payment_method      text check (payment_method is null or payment_method in
                        ('apple_pay', 'paypal', 'card', 'bank_transfer', 'crypto', 'invoice', 'binance')),

  status              text not null default 'new'
                        check (status in ('new', 'under_review', 'approved', 'rejected', 'more_info')),
  reviewer_id         uuid references public.admin_profiles (id) on delete set null,
  product_count       integer not null default 0 check (product_count between 0 and 30),

  terms_document_id   uuid not null references public.terms_documents (id) on delete restrict,
  terms_version       text not null,
  terms_sha256        text,
  terms_accepted_at   timestamptz not null,
  consent_confirmed   boolean not null default true check (consent_confirmed),

  submission_ip       inet,
  upload_token        text not null default '' check (upload_token = '' or upload_token ~* '^[a-f0-9-]{16,64}$'),
  submitted_at        timestamptz not null default now(),
  first_response_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists applications_status_idx on public.applications (status, submitted_at desc);
create index if not exists applications_submitted_idx on public.applications (submitted_at desc);
create index if not exists applications_email_idx on public.applications (lower(email));
create index if not exists applications_country_idx on public.applications (country);
create index if not exists applications_reviewer_idx on public.applications (reviewer_id);

-- ---------------------------------------------------------------------------
-- Products selected by the applicant (max 30, enforced by trigger)
-- ---------------------------------------------------------------------------
create table if not exists public.application_products (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  position       integer not null check (position between 1 and 30),
  name           text not null default '' check (char_length(name) <= 200),
  url            text check (url is null or char_length(url) <= 2000),
  variant        text not null default '' check (char_length(variant) <= 200),
  notes          text not null default '' check (char_length(notes) <= 1000),
  created_at     timestamptz not null default now(),
  unique (application_id, position)
);
create index if not exists application_products_app_idx on public.application_products (application_id, position);

create table if not exists public.application_product_files (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.application_products (id) on delete cascade,
  storage_path  text not null unique check (storage_path ~ '^(temp|applications)/'),
  mime_type     text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  file_size     bigint not null check (file_size > 0),
  sha256        text check (sha256 is null or sha256 ~* '^[0-9a-f]{64}$'),
  original_name text not null default '' check (char_length(original_name) <= 200),
  created_at    timestamptz not null default now()
);
create index if not exists application_product_files_product_idx
  on public.application_product_files (product_id);

-- ---------------------------------------------------------------------------
-- Supporting / generated documents
-- ---------------------------------------------------------------------------
create table if not exists public.application_documents (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  kind           text not null default 'supporting'
                   check (kind in ('supporting', 'confirmation_pdf', 'system')),
  label          text not null default '' check (char_length(label) <= 200),
  storage_path   text not null unique check (storage_path like 'application-docs/%'),
  mime_type      text not null default 'application/pdf',
  file_size      bigint not null default 0 check (file_size >= 0),
  sha256         text check (sha256 is null or sha256 ~* '^[0-9a-f]{64}$'),
  created_by     uuid references public.admin_profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists application_documents_app_idx on public.application_documents (application_id);

-- ---------------------------------------------------------------------------
-- Private notes and status history (never exposed to applicants)
-- ---------------------------------------------------------------------------
create table if not exists public.application_notes (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  author_id      uuid references public.admin_profiles (id) on delete set null,
  body           text not null check (char_length(body) between 1 and 5000),
  created_at     timestamptz not null default now()
);
create index if not exists application_notes_app_idx
  on public.application_notes (application_id, created_at desc);

create table if not exists public.application_status_history (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  from_status    text check (from_status is null or from_status in
                   ('new', 'under_review', 'approved', 'rejected', 'more_info')),
  to_status      text not null check (to_status in
                   ('new', 'under_review', 'approved', 'rejected', 'more_info')),
  changed_by     uuid references public.admin_profiles (id) on delete set null,
  reason         text check (reason is null or char_length(reason) <= 1000),
  created_at     timestamptz not null default now()
);
create index if not exists application_status_history_app_idx
  on public.application_status_history (application_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Public-safe settings singleton (branding, shop, copy, application control)
-- ---------------------------------------------------------------------------
create table if not exists public.application_settings (
  id                       boolean primary key default true check (id),

  brand_name               text not null default 'Fortuna Skin' check (char_length(brand_name) <= 120),
  logo_url                 text not null default '' check (logo_url = '' or logo_url ~* '^https?://'),
  primary_color            text not null default '#1f3a32' check (primary_color ~* '^#[0-9a-fA-F]{6}$'),
  secondary_color          text not null default '#b98a4b' check (secondary_color ~* '^#[0-9a-fA-F]{6}$'),
  background_color         text not null default '#faf8f4' check (background_color ~* '^#[0-9a-fA-F]{6}$'),
  font_selection           text not null default 'editorial'
                             check (font_selection in ('editorial', 'modern', 'classic')),

  welcome_heading          text not null default 'Partner with us' check (char_length(welcome_heading) <= 200),
  welcome_description      text not null default '' check (char_length(welcome_description) <= 2000),
  application_instructions text not null default '' check (char_length(application_instructions) <= 4000),
  footer_text              text not null default '' check (char_length(footer_text) <= 1000),
  contact_email            text not null default '' check (contact_email = '' or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  privacy_policy_url       text not null default '' check (privacy_policy_url = '' or privacy_policy_url ~* '^https?://'),
  success_message          text not null default
                             'Your application has been submitted successfully. Our team will review your information and contact you using the email address provided.'
                             check (char_length(success_message) <= 2000),
  estimated_time           text not null default 'About 10 minutes' check (char_length(estimated_time) <= 80),
  response_time_message    text not null default '' check (char_length(response_time_message) <= 300),

  shop_url                 text not null default '' check (shop_url = '' or shop_url ~* '^https?://'),
  shop_button_label        text not null default 'Open Official Shop' check (char_length(shop_button_label) <= 80),
  shop_name                text not null default '' check (char_length(shop_name) <= 160),
  product_instructions     text not null default '' check (char_length(product_instructions) <= 3000),
  product_url_enabled      boolean not null default true,
  product_image_enabled    boolean not null default true,
  min_products             integer not null default 0 check (min_products between 0 and 30),
  max_products             integer not null default 30 check (max_products between 1 and 30),

  applications_paused      boolean not null default false,
  closure_message          text not null default
                             'Applications are currently closed. Please check back later.'
                             check (char_length(closure_message) <= 1000),

  updated_by               uuid references public.admin_profiles (id) on delete set null,
  updated_at               timestamptz not null default now(),
  constraint min_lte_max check (min_products <= max_products)
);

-- ---------------------------------------------------------------------------
-- Form builder configuration (public-safe)
-- ---------------------------------------------------------------------------
create table if not exists public.form_field_settings (
  id          uuid primary key default gen_random_uuid(),
  field_key   text not null unique check (field_key ~* '^[a-z][a-z0-9_]{1,50}$'),
  label       text not null check (char_length(label) between 1 and 160),
  placeholder text not null default '' check (char_length(placeholder) <= 160),
  helper_text text not null default '' check (char_length(helper_text) <= 500),
  step        integer not null check (step between 1 and 4),
  position    integer not null check (position between 1 and 100),
  enabled     boolean not null default true,
  required    boolean not null default false,
  locked      boolean not null default false,
  field_type  text not null default 'text'
                check (field_type in ('text', 'email', 'tel', 'url', 'select', 'textarea', 'handles', 'payment', 'country')),
  options     jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  updated_at  timestamptz not null default now()
);
create index if not exists form_field_settings_step_idx on public.form_field_settings (step, position);

-- ---------------------------------------------------------------------------
-- Privileged administrator preferences (never readable by anon)
-- ---------------------------------------------------------------------------
create table if not exists public.admin_preferences (
  id                          boolean primary key default true check (id),
  admin_notification_email    text not null default ''
                                check (admin_notification_email = '' or admin_notification_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notify_admin_on_submission  boolean not null default true,
  notify_applicant_confirmation boolean not null default true,
  notify_status_changes       boolean not null default false,
  notify_terms_published      boolean not null default false,
  applicant_confirmation_subject text not null default 'We received your partnership application'
                                check (char_length(applicant_confirmation_subject) <= 200),
  applicant_confirmation_body text not null default
    'Hi {{name}},{{newline}}{{newline}}We have received your partnership application (reference {{reference}}). Our team will review your information and contact you at {{email}}.{{newline}}{{newline}}Thank you for your interest in collaborating with us.',
  status_subject              text not null default 'Update on your partnership application {{reference}}'
                                check (char_length(status_subject) <= 200),
  status_body                 text not null default
    'Hi {{name}},{{newline}}{{newline}}Your application {{reference}} is now marked as "{{status}}".{{newline}}{{newline}}{{reason}}',
  max_upload_mb               integer not null default 8 check (max_upload_mb between 1 and 50),
  accepted_image_types        text[] not null default array['image/jpeg', 'image/png', 'image/webp'],
  terms_max_mb                integer not null default 25 check (terms_max_mb between 1 and 100),
  updated_by                  uuid references public.admin_profiles (id) on delete set null,
  updated_at                   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log for important administrative actions
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid references public.admin_profiles (id) on delete set null,
  action      text not null check (char_length(action) between 1 and 80),
  entity_type text not null default '' check (char_length(entity_type) <= 60),
  entity_id   text not null default '' check (char_length(entity_id) <= 120),
  metadata    jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  ip          text not null default '' check (char_length(ip) <= 60),
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_logs_created_idx on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_logs_admin_idx on public.admin_audit_logs (admin_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Rate limiting buckets used by edge functions
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket       text not null check (char_length(bucket) <= 60),
  key          text not null check (char_length(key) <= 200),
  window_start timestamptz not null default now(),
  count        integer not null default 1 check (count >= 0),
  primary key (bucket, key)
);

-- ---------------------------------------------------------------------------
-- Notification delivery log (does not affect submission success)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_log (
  id                 uuid primary key default gen_random_uuid(),
  application_id     uuid references public.applications (id) on delete cascade,
  kind               text not null check (char_length(kind) <= 60),
  recipient          text not null default '',
  status             text not null check (status in ('sent', 'failed', 'skipped')),
  provider_message_id text not null default '',
  error              text not null default '' check (char_length(error) <= 1000),
  created_at         timestamptz not null default now()
);
create index if not exists notification_log_created_idx on public.notification_log (created_at desc);
create index if not exists notification_log_app_idx on public.notification_log (application_id);
