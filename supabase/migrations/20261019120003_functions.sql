-- 0003: Functions, triggers and privileged RPCs
-- Security model:
--   * finalize_application  -> executable by service_role only (called from the submit edge function)
--   * all admin_* RPCs      -> executable by authenticated only, each re-checks is_admin()
--   * is_admin()            -> security definer helper used by RLS policies

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = auth.uid()
      and is_active
  );
$$;

create or replace function public.is_safe_url(p text)
returns boolean
language sql
immutable
as $$
  select p is null or p = '' or (
    p ~* '^https?://'
    and char_length(p) <= 2000
    and p !~ '\s'
    and p !~* '^https?://[^/?#]*@'
    and p !~* 'javascript:'
    and p !~* 'data:text/html'
  );
$$;

create or replace function public.sanitized_text(p text, p_max integer)
returns text
language sql
immutable
as $$
  select left(nullif(regexp_replace(coalesce(p, ''), E'\\x00', '', 'g'), ''), greatest(p_max, 1));
$$;

create or replace function public.text_is_safe(p text)
returns boolean
language sql
immutable
as $$
  select p is null or (
    p !~* '<\s*script'
    and p !~* 'javascript:'
    and p !~* 'data:text/html'
    and p !~* 'on\w+\s*=\s*"'
  );
$$;

create or replace function public.normalize_handle(p text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(trim(coalesce(p, '')), '^@+', ''), '');
$$;

create or replace function public.is_valid_handle(p text)
returns boolean
language sql
immutable
as $$
  select p is null or p ~ '^[A-Za-z0-9._-]{1,64}$';
$$;

create or replace function public.is_valid_ip(p text)
returns boolean
language sql
immutable
as $$
  select p is null or p = '' or p ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$' or p ~ '^[0-9a-fA-F:]+$';
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['admin_profiles', 'terms_documents', 'applications',
                           'application_settings', 'form_field_settings', 'admin_preferences']
  loop
    execute format(
      'drop trigger if exists %1$s_touch on public.%1$s;
       create trigger %1$s_touch before update on public.%1$s
         for each row execute function public.touch_updated_at();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Product limit (concurrency safe) + denormalised product_count
-- ---------------------------------------------------------------------------
create or replace function public.enforce_product_limit()
returns trigger
language plpgsql
as $$
declare
  v_max integer;
  v_existing integer;
  v_app uuid;
begin
  v_app := coalesce(new.application_id, old.application_id);
  -- serialise concurrent inserts for the same application
  perform pg_advisory_xact_lock(hashtextextended(v_app::text, 42));

  select least(max_products, 30) into v_max from public.application_settings where id;

  select count(*)
  into v_existing
  from public.application_products
  where application_id = v_app
    and (tg_op <> 'UPDATE' or id <> new.id);

  if coalesce(v_max, 30) < 1 then
    v_max := 30;
  end if;

  if v_existing + 1 > v_max then
    raise exception 'max_products' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists application_products_limit on public.application_products;
create trigger application_products_limit
  before insert or update on public.application_products
  for each row execute function public.enforce_product_limit();

create or replace function public.refresh_product_count()
returns trigger
language plpgsql
as $$
declare
  v_app uuid;
begin
  v_app := coalesce(new.application_id, old.application_id);
  update public.applications
  set product_count = (
    select count(*) from public.application_products where application_id = v_app
  )
  where id = v_app;
  return coalesce(new, old);
end;
$$;

drop trigger if exists application_products_count on public.application_products;
create trigger application_products_count
  after insert or update or delete on public.application_products
  for each row execute function public.refresh_product_count();

-- ---------------------------------------------------------------------------
-- finalize_application: the only way applicant data enters the database.
-- Executed by the submit edge function with the service role key.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_application(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings        public.application_settings%rowtype;
  v_prefs           public.admin_preferences%rowtype;
  v_terms           public.terms_documents%rowtype;
  v_fields          jsonb;
  v_cfg            jsonb;
  v_app_id          uuid;
  v_idem            text;
  v_token           text;
  v_existing        public.applications%rowtype;
  v_products        jsonb;
  v_count           integer;
  v_ref             text;
  v_f               jsonb;
  v_files           jsonb;
  v_file            jsonb;
  v_path            text;
  v_product_id      uuid;
  v_pos             integer;
  v_val             text;
  v_req             boolean;
  v_dis             boolean;
  v_key             text;
  v_ip              text;
  v_app             public.applications%rowtype;
  v_accepted_types  text[];

  -- field values
  v_full_name           text;
  v_email               text;
  v_phone               text;
  v_country             text;
  v_region              text;
  v_address_street      text;
  v_address_line2       text;
  v_address_city        text;
  v_address_region      text;
  v_address_postal_code text;
  v_address_country     text;
  v_instagram_handle    text;
  v_tiktok_handle       text;
  v_other_handles       jsonb;
  v_portfolio_url       text;
  v_budget              text;
  v_payment_method      text;
begin
  -- ------------------------------------------------------------------ basics
  v_app_id := nullif(p ->> 'application_id', '')::uuid;
  v_idem   := coalesce(p ->> 'idempotency_key', '');
  v_token  := coalesce(p ->> 'upload_token', '');
  v_ip     := nullif(p ->> 'submission_ip', '');

  if v_app_id is null then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if char_length(v_idem) < 16 or char_length(v_idem) > 80 then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if v_token !~ '^[a-f0-9-]{16,64}$' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if not public.is_valid_ip(v_ip) then
    v_ip := null;
  end if;

  -- idempotent replay
  select * into v_existing from public.applications where idempotency_key = v_idem;
  if found then
    return jsonb_build_object(
      'id', v_existing.id,
      'reference', v_existing.reference,
      'submitted_at', v_existing.submitted_at,
      'product_count', v_existing.product_count,
      'duplicate', true
    );
  end if;

  -- ------------------------------------------------------------- pause switch
  select * into v_settings from public.application_settings where id;
  if v_settings.applications_paused then
    raise exception 'applications_paused' using errcode = 'P0001';
  end if;

  -- ------------------------------------------------------------- field config
  select coalesce(
    (select jsonb_object_agg(field_key, jsonb_build_object(
              'enabled', enabled, 'required', required, 'locked', locked, 'label', label))
     from public.form_field_settings),
    '{}'::jsonb
  ) into v_fields;

  v_full_name           := public.sanitized_text(p ->> 'full_name', 200);
  v_email               := lower(public.sanitized_text(p ->> 'email', 254));
  v_phone               := public.sanitized_text(p ->> 'phone', 40);
  v_country             := public.sanitized_text(p ->> 'country', 120);
  v_region              := public.sanitized_text(p ->> 'region', 120);
  v_address_street      := public.sanitized_text(p ->> 'address_street', 300);
  v_address_line2       := public.sanitized_text(p ->> 'address_line2', 300);
  v_address_city        := public.sanitized_text(p ->> 'address_city', 200);
  v_address_region      := public.sanitized_text(p ->> 'address_region', 200);
  v_address_postal_code := public.sanitized_text(p ->> 'address_postal_code', 40);
  v_address_country     := public.sanitized_text(p ->> 'address_country', 120);
  v_instagram_handle    := coalesce(public.normalize_handle(p ->> 'instagram_handle'), '');
  v_tiktok_handle       := coalesce(public.normalize_handle(p ->> 'tiktok_handle'), '');
  v_portfolio_url       := nullif(public.sanitized_text(p ->> 'portfolio_url', 500), '');
  v_budget              := public.sanitized_text(p ->> 'budget', 120);
  v_payment_method      := nullif(public.sanitized_text(p ->> 'payment_method', 40), '');
  v_other_handles       := coalesce(p -> 'other_handles', '[]'::jsonb);

  if jsonb_typeof(v_other_handles) <> 'array' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_other_handles) > 20 then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  -- per-field enabled/required enforcement (locked fields can never be skipped)
  for v_key, v_cfg in select * from jsonb_each(v_fields)
  loop
    v_dis := not (v_cfg ->> 'enabled')::boolean;
    v_req := (v_cfg ->> 'required')::boolean or (v_cfg ->> 'locked')::boolean;

    if v_key in ('other_handles', 'payment_method') then
      continue; -- handled below with custom types
    end if;

    v_val := case v_key
      when 'full_name' then v_full_name
      when 'email' then v_email
      when 'phone' then v_phone
      when 'country' then v_country
      when 'region' then v_region
      when 'address_street' then v_address_street
      when 'address_line2' then v_address_line2
      when 'address_city' then v_address_city
      when 'address_region' then v_address_region
      when 'address_postal_code' then v_address_postal_code
      when 'address_country' then v_address_country
      when 'instagram_handle' then v_instagram_handle
      when 'tiktok_handle' then v_tiktok_handle
      when 'portfolio_url' then coalesce(v_portfolio_url, '')
      when 'budget' then v_budget
      else ''
    end;

    if v_dis then
      v_val := '';
    elsif v_req and coalesce(v_val, '') = '' then
      raise exception 'required_field:%', v_key using errcode = 'P0001';
    end if;

    case v_key
      when 'full_name' then v_full_name := v_val;
      when 'email' then v_email := v_val;
      when 'phone' then v_phone := v_val;
      when 'country' then v_country := v_val;
      when 'region' then v_region := v_val;
      when 'address_street' then v_address_street := v_val;
      when 'address_line2' then v_address_line2 := v_val;
      when 'address_city' then v_address_city := v_val;
      when 'address_region' then v_address_region := v_val;
      when 'address_postal_code' then v_address_postal_code := v_val;
      when 'address_country' then v_address_country := v_val;
      when 'instagram_handle' then v_instagram_handle := v_val;
      when 'tiktok_handle' then v_tiktok_handle := v_val;
      when 'portfolio_url' then v_portfolio_url := nullif(v_val, '');
      when 'budget' then v_budget := v_val;
    end case;
  end loop;

  -- core identity checks (cannot be disabled through configuration)
  if coalesce(v_full_name, '') = '' then
    raise exception 'required_field:full_name' using errcode = 'P0001';
  end if;
  if coalesce(v_email, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_field:email' using errcode = 'P0001';
  end if;
  if coalesce(v_address_street, '') = '' or coalesce(v_address_city, '') = ''
     or coalesce(v_address_country, '') = '' then
    raise exception 'required_field:address' using errcode = 'P0001';
  end if;
  if coalesce(v_instagram_handle, '') <> '' and not public.is_valid_handle(v_instagram_handle) then
    raise exception 'invalid_field:instagram_handle' using errcode = 'P0001';
  end if;
  if coalesce(v_tiktok_handle, '') <> '' and not public.is_valid_handle(v_tiktok_handle) then
    raise exception 'invalid_field:tiktok_handle' using errcode = 'P0001';
  end if;
  if v_portfolio_url is not null and not public.is_safe_url(v_portfolio_url) then
    raise exception 'invalid_field:portfolio_url' using errcode = 'P0001';
  end if;
  if v_payment_method is not null and v_payment_method not in
     ('apple_pay', 'paypal', 'card', 'bank_transfer', 'crypto', 'invoice', 'binance') then
    raise exception 'invalid_field:payment_method' using errcode = 'P0001';
  end if;

  -- ------------------------------------------------------------------ terms
  select * into v_terms
  from public.terms_documents
  where is_current and status = 'published';

  if not found then
    raise exception 'terms_unavailable' using errcode = 'P0001';
  end if;
  if not coalesce((p ->> 'consent')::boolean, false)
     or not coalesce((p ->> 'terms_reviewed')::boolean, false) then
    raise exception 'consent_required' using errcode = 'P0001';
  end if;
  if nullif(p ->> 'terms_document_id', '')::uuid is distinct from v_terms.id
     or coalesce(p ->> 'terms_version', '') is distinct from v_terms.version
     or (v_terms.sha256 is not null
         and coalesce(p ->> 'terms_sha256', '') <> ''
         and coalesce(p ->> 'terms_sha256', '') is distinct from v_terms.sha256) then
    raise exception 'terms_version_mismatch' using errcode = 'P0001';
  end if;

  -- --------------------------------------------------------------- products
  v_products := coalesce(p -> 'products', '[]'::jsonb);
  if jsonb_typeof(v_products) <> 'array' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(v_products);

  if v_count > least(coalesce(v_settings.max_products, 30), 30) or v_count > 30 then
    raise exception 'max_products' using errcode = 'P0001';
  end if;
  if v_count < coalesce(v_settings.min_products, 0) then
    raise exception 'min_products' using errcode = 'P0001';
  end if;

  select coalesce(accepted_image_types, array['image/jpeg', 'image/png', 'image/webp'])
  into v_accepted_types
  from public.admin_preferences where id;

  -- ---------------------------------------------------------------- insert
  v_full_name           := coalesce(v_full_name, '');
  v_email               := coalesce(v_email, '');
  v_phone               := coalesce(v_phone, '');
  v_country             := coalesce(v_country, '');
  v_region              := coalesce(v_region, '');
  v_address_street      := coalesce(v_address_street, '');
  v_address_line2       := coalesce(v_address_line2, '');
  v_address_city        := coalesce(v_address_city, '');
  v_address_region      := coalesce(v_address_region, '');
  v_address_postal_code := coalesce(v_address_postal_code, '');
  v_address_country     := coalesce(v_address_country, '');
  v_instagram_handle    := coalesce(v_instagram_handle, '');
  v_tiktok_handle       := coalesce(v_tiktok_handle, '');
  v_budget              := coalesce(v_budget, '');

  v_ref := 'CPA-' || lpad(nextval('public.application_reference_seq')::text, 6, '0');

  begin
    insert into public.applications (
      id, reference, idempotency_key,
      full_name, email, phone, country, region,
      address_street, address_line2, address_city, address_region,
      address_postal_code, address_country,
      instagram_handle, tiktok_handle, other_handles, portfolio_url, budget, payment_method,
      terms_document_id, terms_version, terms_sha256, terms_accepted_at, consent_confirmed,
      submission_ip, upload_token, submitted_at
    ) values (
      v_app_id, v_ref, v_idem,
      v_full_name, v_email, v_phone, v_country, v_region,
      v_address_street, v_address_line2, v_address_city, v_address_region,
      v_address_postal_code, v_address_country,
      v_instagram_handle, v_tiktok_handle, v_other_handles, v_portfolio_url, v_budget, v_payment_method,
      v_terms.id, v_terms.version, v_terms.sha256, now(), true,
      nullif(v_ip, '')::inet, v_token, now()
    );
  exception when unique_violation then
    if sqlerrm like '%idempotency_key%' then
      select * into v_existing from public.applications where idempotency_key = v_idem;
      return jsonb_build_object(
        'id', v_existing.id,
        'reference', v_existing.reference,
        'submitted_at', v_existing.submitted_at,
        'product_count', v_existing.product_count,
        'duplicate', true
      );
    end if;
    raise;
  end;

  for v_pos in 0 .. v_count - 1 loop
    v_f := v_products -> v_pos;

    if jsonb_typeof(v_f) <> 'object' then
      raise exception 'invalid_payload' using errcode = 'P0001';
    end if;

    declare
      v_name    text := public.sanitized_text(v_f ->> 'name', 200);
      v_url     text := nullif(public.sanitized_text(v_f ->> 'url', 2000), '');
      v_variant text := public.sanitized_text(v_f ->> 'variant', 200);
      v_notes   text := public.sanitized_text(v_f ->> 'notes', 1000);
      v_nfiles  integer;
    begin
      if v_url is not null and not public.is_safe_url(v_url) then
        raise exception 'invalid_url' using errcode = 'P0001';
      end if;

      v_files := coalesce(v_f -> 'files', '[]'::jsonb);
      if jsonb_typeof(v_files) <> 'array' then
        raise exception 'invalid_payload' using errcode = 'P0001';
      end if;
      v_nfiles := jsonb_array_length(v_files);
      if v_nfiles > 3 then
        raise exception 'invalid_payload' using errcode = 'P0001';
      end if;

      if coalesce(v_name, '') = '' and v_url is null and v_nfiles = 0 then
        raise exception 'product_incomplete:%', (v_pos + 1) using errcode = 'P0001';
      end if;

      insert into public.application_products (application_id, position, name, url, variant, notes)
      values (v_app_id, v_pos + 1, coalesce(v_name, ''), v_url,
              coalesce(v_variant, ''), coalesce(v_notes, ''))
      returning id into v_product_id;

      for v_file in select * from jsonb_array_elements(v_files)
      loop
        v_path := nullif(v_file ->> 'storage_path', '');

        if v_path is null
           or v_path !~ '^applications/[0-9a-fA-F-]{36}/products/[0-9a-fA-F-]{36}\.[a-z0-9]{2,5}$'
           or lower(split_part(v_path, '/', 2)) <> v_app_id::text then
          raise exception 'invalid_upload_path' using errcode = 'P0001';
        end if;
        if coalesce(v_file ->> 'mime_type', '') not in ('image/jpeg', 'image/png', 'image/webp')
           or coalesce(v_file ->> 'mime_type', '') <> all (v_accepted_types) then
          raise exception 'invalid_file_type' using errcode = 'P0001';
        end if;
        if coalesce((v_file ->> 'file_size')::bigint, 0)
           > coalesce((select max_upload_mb from public.admin_preferences where id), 8) * 1024 * 1024 then
          raise exception 'file_too_large' using errcode = 'P0001';
        end if;
        if coalesce((v_file ->> 'file_size')::bigint, 0) < 1 then
          raise exception 'invalid_file' using errcode = 'P0001';
        end if;

        insert into public.application_product_files (
          product_id, storage_path, mime_type, file_size, sha256, original_name
        ) values (
          v_product_id,
          v_path,
          v_file ->> 'mime_type',
          (v_file ->> 'file_size')::bigint,
          nullif(v_file ->> 'sha256', ''),
          coalesce(public.sanitized_text(v_file ->> 'original_name', 200), '')
        );
      end loop;
    end;
  end loop;

  select * into v_app from public.applications where id = v_app_id;

  return jsonb_build_object(
    'id', v_app.id,
    'reference', v_app.reference,
    'submitted_at', v_app.submitted_at,
    'product_count', v_app.product_count,
    'terms_version', v_app.terms_version,
    'duplicate', false
  );
end;
$$;

revoke execute on function public.finalize_application(jsonb) from public, anon, authenticated;
grant execute on function public.finalize_application(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Admin RPC: save branding / shop / content settings
-- ---------------------------------------------------------------------------
create or replace function public.save_application_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur public.application_settings%rowtype;
  v_next public.application_settings%rowtype;
  v_key text;
  v_val jsonb;
  v_text text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_cur from public.application_settings where id;
  v_next := v_cur;

  for v_key, v_val in select * from jsonb_each(p)
  loop
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      continue;
    end if;
    if jsonb_typeof(v_val) = 'boolean' then
      case v_key
        when 'product_url_enabled' then v_next.product_url_enabled := (v_val #>> '{}')::boolean;
        when 'product_image_enabled' then v_next.product_image_enabled := (v_val #>> '{}')::boolean;
        when 'applications_paused' then v_next.applications_paused := (v_val #>> '{}')::boolean;
        else raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
      end case;
    elsif jsonb_typeof(v_val) = 'number' then
      case v_key
        when 'min_products' then v_next.min_products := round((v_val #>> '{}')::numeric)::integer;
        when 'max_products' then v_next.max_products := round((v_val #>> '{}')::numeric)::integer;
        else raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
      end case;
    elsif jsonb_typeof(v_val) = 'string' then
      v_text := v_val #>> '{}';
      if not public.text_is_safe(v_text) then
        raise exception 'unsafe_content:%', v_key using errcode = 'P0001';
      end if;
      case v_key
        when 'brand_name' then v_next.brand_name := public.sanitized_text(v_text, 120);
        when 'logo_url' then
          v_text := nullif(public.sanitized_text(v_text, 500), '');
          if v_text is not null and not public.is_safe_url(v_text) then
            raise exception 'invalid_field:logo_url' using errcode = 'P0001';
          end if;
          v_next.logo_url := coalesce(v_text, '');
        when 'primary_color' then
          if v_text !~* '^#[0-9a-fA-F]{6}$' then raise exception 'invalid_field:primary_color' using errcode = 'P0001'; end if;
          v_next.primary_color := lower(v_text);
        when 'secondary_color' then
          if v_text !~* '^#[0-9a-fA-F]{6}$' then raise exception 'invalid_field:secondary_color' using errcode = 'P0001'; end if;
          v_next.secondary_color := lower(v_text);
        when 'background_color' then
          if v_text !~* '^#[0-9a-fA-F]{6}$' then raise exception 'invalid_field:background_color' using errcode = 'P0001'; end if;
          v_next.background_color := lower(v_text);
        when 'font_selection' then
          if v_text not in ('editorial', 'modern', 'classic') then raise exception 'invalid_field:font_selection' using errcode = 'P0001'; end if;
          v_next.font_selection := v_text;
        when 'welcome_heading' then v_next.welcome_heading := public.sanitized_text(v_text, 200);
        when 'welcome_description' then v_next.welcome_description := public.sanitized_text(v_text, 2000);
        when 'application_instructions' then v_next.application_instructions := public.sanitized_text(v_text, 4000);
        when 'footer_text' then v_next.footer_text := public.sanitized_text(v_text, 1000);
        when 'contact_email' then
          v_text := lower(nullif(public.sanitized_text(v_text, 254), ''));
          if v_text is not null and v_text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
            raise exception 'invalid_field:contact_email' using errcode = 'P0001';
          end if;
          v_next.contact_email := coalesce(v_text, '');
        when 'privacy_policy_url' then
          v_text := nullif(public.sanitized_text(v_text, 500), '');
          if v_text is not null and not public.is_safe_url(v_text) then
            raise exception 'invalid_field:privacy_policy_url' using errcode = 'P0001';
          end if;
          v_next.privacy_policy_url := coalesce(v_text, '');
        when 'success_message' then v_next.success_message := public.sanitized_text(v_text, 2000);
        when 'estimated_time' then v_next.estimated_time := public.sanitized_text(v_text, 80);
        when 'response_time_message' then v_next.response_time_message := public.sanitized_text(v_text, 300);
        when 'shop_url' then
          v_text := nullif(public.sanitized_text(v_text, 500), '');
          if v_text is not null and not public.is_safe_url(v_text) then
            raise exception 'invalid_field:shop_url' using errcode = 'P0001';
          end if;
          v_next.shop_url := coalesce(v_text, '');
        when 'shop_button_label' then v_next.shop_button_label := public.sanitized_text(v_text, 80);
        when 'shop_name' then v_next.shop_name := public.sanitized_text(v_text, 160);
        when 'product_instructions' then v_next.product_instructions := public.sanitized_text(v_text, 3000);
        when 'closure_message' then v_next.closure_message := public.sanitized_text(v_text, 1000);
        else raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
      end case;
    else
      raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
    end if;
  end loop;

  if v_next.min_products > v_next.max_products or v_next.max_products > 30 then
    raise exception 'invalid_product_limits' using errcode = 'P0001';
  end if;
  if not public.text_is_safe(v_next.welcome_heading)
     or not public.text_is_safe(v_next.success_message)
     or not public.text_is_safe(v_next.closure_message) then
    raise exception 'unsafe_content' using errcode = 'P0001';
  end if;

  update public.application_settings
  set brand_name = v_next.brand_name,
      logo_url = v_next.logo_url,
      primary_color = v_next.primary_color,
      secondary_color = v_next.secondary_color,
      background_color = v_next.background_color,
      font_selection = v_next.font_selection,
      welcome_heading = v_next.welcome_heading,
      welcome_description = v_next.welcome_description,
      application_instructions = v_next.application_instructions,
      footer_text = v_next.footer_text,
      contact_email = v_next.contact_email,
      privacy_policy_url = v_next.privacy_policy_url,
      success_message = v_next.success_message,
      estimated_time = v_next.estimated_time,
      response_time_message = v_next.response_time_message,
      shop_url = v_next.shop_url,
      shop_button_label = v_next.shop_button_label,
      shop_name = v_next.shop_name,
      product_instructions = v_next.product_instructions,
      product_url_enabled = v_next.product_url_enabled,
      product_image_enabled = v_next.product_image_enabled,
      min_products = v_next.min_products,
      max_products = v_next.max_products,
      applications_paused = v_next.applications_paused,
      closure_message = v_next.closure_message,
      updated_by = auth.uid()
  where id
  returning * into v_next;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'settings.update', 'application_settings', 'singleton',
          jsonb_build_object('keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p) k)));

  return to_jsonb(v_next);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: form builder
-- ---------------------------------------------------------------------------
create or replace function public.save_form_fields(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_key text;
  v_row public.form_field_settings%rowtype;
  v_enabled boolean;
  v_required boolean;
  v_locked boolean;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 60 then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p)
  loop
    v_key := nullif(v_item ->> 'field_key', '');
    if v_key is null then
      raise exception 'invalid_payload' using errcode = 'P0001';
    end if;

    select * into v_row from public.form_field_settings where field_key = v_key;
    if not found then
      raise exception 'unknown_field:%', v_key using errcode = 'P0001';
    end if;

    v_locked := v_row.locked;
    v_enabled := coalesce((v_item ->> 'enabled')::boolean, v_row.enabled);
    v_required := coalesce((v_item ->> 'required')::boolean, v_row.required);

    if v_locked then
      v_enabled := true;
      v_required := true;
    end if;

    update public.form_field_settings
    set label = coalesce(public.sanitized_text(v_item ->> 'label', 160), label),
        placeholder = coalesce(public.sanitized_text(v_item ->> 'placeholder', 160), placeholder),
        helper_text = coalesce(public.sanitized_text(v_item ->> 'helper_text', 500), helper_text),
        step = coalesce((v_item ->> 'step')::integer, step),
        position = coalesce((v_item ->> 'position')::integer, position),
        enabled = v_enabled,
        required = v_required,
        updated_at = now()
    where field_key = v_key;
  end loop;

  -- normalise positions per step
  with ordered as (
    select id, row_number() over (partition by step order by position, updated_at desc) as rn
    from public.form_field_settings
  )
  update public.form_field_settings f
  set position = o.rn
  from ordered o
  where f.id = o.id and f.position <> o.rn;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'form_fields.update', 'form_field_settings', '',
          jsonb_build_object('count', jsonb_array_length(p)));

  return coalesce((
    select jsonb_agg(to_jsonb(f) order by f.step, f.position)
    from public.form_field_settings f
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: status changes (+ audit history)
-- ---------------------------------------------------------------------------
create or replace function public.update_application_status(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_id uuid := nullif(p ->> 'application_id', '')::uuid;
  v_to text := p ->> 'to_status';
  v_reason text := nullif(public.sanitized_text(p ->> 'reason', 1000), '');
  v_app public.applications%rowtype;
  v_from_status text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_app_id is null or v_to not in ('new', 'under_review', 'approved', 'rejected', 'more_info') then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  select * into v_app from public.applications where id = v_app_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_app.status = v_to then
    return to_jsonb(v_app);
  end if;
  v_from_status := v_app.status;

  insert into public.application_status_history (application_id, from_status, to_status, changed_by, reason)
  values (v_app_id, v_app.status, v_to, auth.uid(), v_reason);

  update public.applications
  set status = v_to,
      first_response_at = coalesce(first_response_at, case when status = 'new' then now() end)
  where id = v_app_id
  returning * into v_app;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'application.status_change', 'application', v_app_id::text,
          jsonb_build_object('from', v_from_status, 'to', v_to, 'reason_set', v_reason is not null));

  return to_jsonb(v_app);
end;
$$;

create or replace function public.bulk_update_application_status(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb := p -> 'ids';
  v_to text := p ->> 'to_status';
  v_reason text := nullif(public.sanitized_text(p ->> 'reason', 1000), '');
  v_id uuid;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) = 0
     or jsonb_array_length(v_ids) > 500
     or v_to not in ('new', 'under_review', 'approved', 'rejected', 'more_info') then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  for v_id in select (value)::uuid from jsonb_array_elements(v_ids)
  loop
    perform public.update_application_status(jsonb_build_object(
      'application_id', v_id, 'to_status', v_to, 'reason', v_reason
    ));
    v_count := v_count + 1;
  end loop;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'application.bulk_status_change', 'application', '',
          jsonb_build_object('count', v_count, 'to_status', v_to));

  return jsonb_build_object('updated', v_count);
end;
$$;

create or replace function public.assign_reviewer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_id uuid := nullif(p ->> 'application_id', '')::uuid;
  v_reviewer uuid := nullif(p ->> 'reviewer_id', '')::uuid;
  v_app public.applications%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_app_id is null then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if v_reviewer is not null and not exists (
    select 1 from public.admin_profiles where id = v_reviewer and is_active
  ) then
    raise exception 'invalid_reviewer' using errcode = 'P0001';
  end if;

  update public.applications set reviewer_id = v_reviewer where id = v_app_id
  returning * into v_app;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'application.assign_reviewer', 'application', v_app_id::text,
          jsonb_build_object('reviewer_id', v_reviewer));

  return to_jsonb(v_app);
end;
$$;

create or replace function public.add_application_note(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_id uuid := nullif(p ->> 'application_id', '')::uuid;
  v_body text := public.sanitized_text(p ->> 'body', 5000);
  v_note public.application_notes%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_app_id is null or coalesce(v_body, '') = '' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.applications where id = v_app_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  insert into public.application_notes (application_id, author_id, body)
  values (v_app_id, auth.uid(), v_body)
  returning * into v_note;

  return to_jsonb(v_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: terms documents
-- ---------------------------------------------------------------------------
create or replace function public.register_terms_document(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.terms_documents%rowtype;
  v_title text := public.sanitized_text(p ->> 'title', 200);
  v_desc text := public.sanitized_text(p ->> 'description', 2000);
  v_version text := nullif(p ->> 'version', '');
  v_path text := nullif(p ->> 'storage_path', '');
  v_size bigint := nullif(p ->> 'file_size', '')::bigint;
  v_sha text := nullif(lower(p ->> 'sha256'), '');
  v_max bigint;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(v_title, '') = '' or v_version is null or v_version !~ '^[A-Za-z0-9._-]{1,40}$'
     or v_path is null or v_path !~ '^terms-docs/[0-9a-fA-F-]{36}\.pdf$' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if v_size is null or v_size < 1 then
    raise exception 'invalid_file' using errcode = 'P0001';
  end if;
  select coalesce(terms_max_mb, 25) * 1024 * 1024 into v_max from public.admin_preferences where id;
  if v_size > coalesce(v_max, 26214400) then
    raise exception 'file_too_large' using errcode = 'P0001';
  end if;
  if v_sha is not null and v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.terms_documents where version = v_version) then
    raise exception 'version_exists' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.terms_documents where storage_path = v_path) then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  insert into public.terms_documents (
    title, description, version, storage_path, file_size, sha256, uploaded_by
  ) values (
    v_title, coalesce(v_desc, ''), v_version, v_path, v_size, v_sha, auth.uid()
  )
  returning * into v_row;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'terms.upload', 'terms_document', v_row.id::text,
          jsonb_build_object('version', v_row.version, 'file_size', v_row.file_size));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.publish_terms(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_row public.terms_documents%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_id is null then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  select * into v_row from public.terms_documents where id = v_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  update public.terms_documents set is_current = false where is_current and id <> v_id;

  update public.terms_documents
  set status = 'published',
      is_current = true,
      published_by = auth.uid(),
      published_at = coalesce(published_at, now()),
      unpublished_at = null
  where id = v_id
  returning * into v_row;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'terms.publish', 'terms_document', v_id::text,
          jsonb_build_object('version', v_row.version));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.unpublish_terms(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_row public.terms_documents%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row from public.terms_documents where id = v_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not v_row.is_current then
    raise exception 'not_current' using errcode = 'P0001';
  end if;

  update public.terms_documents
  set is_current = false, status = 'unpublished', unpublished_at = now()
  where id = v_id
  returning * into v_row;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'terms.unpublish', 'terms_document', v_id::text,
          jsonb_build_object('version', v_row.version));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.delete_terms_document(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_row public.terms_documents%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row from public.terms_documents where id = v_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_row.is_current then
    raise exception 'is_current' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.applications where terms_document_id = v_id) then
    raise exception 'terms_in_use' using errcode = 'P0001';
  end if;

  delete from public.terms_documents where id = v_id;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'terms.delete', 'terms_document', v_id::text,
          jsonb_build_object('version', v_row.version));

  return jsonb_build_object('deleted', true, 'id', v_id, 'storage_path', v_row.storage_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: supporting documents
-- ---------------------------------------------------------------------------
create or replace function public.attach_application_document(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_id uuid := nullif(p ->> 'application_id', '')::uuid;
  v_path text := nullif(p ->> 'storage_path', '');
  v_row public.application_documents%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_app_id is null or not exists (select 1 from public.applications where id = v_app_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_path is null or v_path !~ '^application-docs/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.[a-z0-9]{2,5}$'
     or lower(split_part(v_path, '/', 2)) <> v_app_id::text then
    raise exception 'invalid_upload_path' using errcode = 'P0001';
  end if;

  insert into public.application_documents (
    application_id, kind, label, storage_path, mime_type, file_size, sha256, created_by
  ) values (
    v_app_id, 'supporting',
    coalesce(public.sanitized_text(p ->> 'label', 200), ''),
    v_path,
    coalesce(public.sanitized_text(p ->> 'mime_type', 80), 'application/pdf'),
    coalesce((p ->> 'file_size')::bigint, 0),
    nullif(lower(p ->> 'sha256'), ''),
    auth.uid()
  )
  returning * into v_row;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'application.document_attach', 'application', v_app_id::text,
          jsonb_build_object('document_id', v_row.id));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.delete_application_document(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_row public.application_documents%rowtype;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row from public.application_documents where id = v_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  delete from public.application_documents where id = v_id;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'application.document_delete', 'application', v_row.application_id::text,
          jsonb_build_object('document_id', v_id));

  return jsonb_build_object('deleted', true, 'id', v_id, 'storage_path', v_row.storage_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: preferences + audit helper
-- ---------------------------------------------------------------------------
create or replace function public.save_admin_preferences(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.admin_preferences%rowtype;
  v_key text;
  v_val jsonb;
  v_text text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for v_key, v_val in select * from jsonb_each(p)
  loop
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      continue;
    end if;
    if jsonb_typeof(v_val) = 'boolean' then
      case v_key
        when 'notify_admin_on_submission' then update public.admin_preferences set notify_admin_on_submission = (v_val #>> '{}')::boolean where id;
        when 'notify_applicant_confirmation' then update public.admin_preferences set notify_applicant_confirmation = (v_val #>> '{}')::boolean where id;
        when 'notify_status_changes' then update public.admin_preferences set notify_status_changes = (v_val #>> '{}')::boolean where id;
        when 'notify_terms_published' then update public.admin_preferences set notify_terms_published = (v_val #>> '{}')::boolean where id;
        else raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
      end case;
    elsif jsonb_typeof(v_val) = 'number' then
      case v_key
        when 'max_upload_mb' then update public.admin_preferences set max_upload_mb = least(greatest(round((v_val #>> '{}')::numeric)::integer, 1), 50) where id;
        when 'terms_max_mb' then update public.admin_preferences set terms_max_mb = least(greatest(round((v_val #>> '{}')::numeric)::integer, 1), 100) where id;
        else raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
      end case;
    elsif jsonb_typeof(v_val) = 'string' then
      v_text := v_val #>> '{}';
      if not public.text_is_safe(v_text) then
        raise exception 'unsafe_content:%', v_key using errcode = 'P0001';
      end if;
      case v_key
        when 'admin_notification_email' then update public.admin_preferences set admin_notification_email = lower(public.sanitized_text(v_text, 254)) where id;
        when 'applicant_confirmation_subject' then update public.admin_preferences set applicant_confirmation_subject = public.sanitized_text(v_text, 200) where id;
        when 'applicant_confirmation_body' then update public.admin_preferences set applicant_confirmation_body = public.sanitized_text(v_text, 5000) where id;
        when 'status_subject' then update public.admin_preferences set status_subject = public.sanitized_text(v_text, 200) where id;
        when 'status_body' then update public.admin_preferences set status_body = public.sanitized_text(v_text, 5000) where id;
        else raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
      end case;
    elsif jsonb_typeof(v_val) = 'array' and v_key = 'accepted_image_types' then
      if not (
        select bool_and(value::text in ('image/jpeg', 'image/png', 'image/webp'))
        from jsonb_array_elements(v_val)
      ) or jsonb_array_length(v_val) = 0 then
        raise exception 'invalid_setting:accepted_image_types' using errcode = 'P0001';
      end if;
      update public.admin_preferences
      set accepted_image_types = array(
        select value::text from jsonb_array_elements(v_val)
      )
      where id;
    else
      raise exception 'invalid_setting:%', v_key using errcode = 'P0001';
    end if;
  end loop;

  update public.admin_preferences set updated_by = auth.uid() where id
  returning * into v_row;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'preferences.update', 'admin_preferences', 'singleton',
          jsonb_build_object('keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p) k)));

  return to_jsonb(v_row);
end;
$$;

create or replace function public.log_admin_action(p jsonb)
returns public.admin_audit_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.admin_audit_logs%rowtype;
  v_action text := public.sanitized_text(p ->> 'action', 80);
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(v_action, '') = '' then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  insert into public.admin_audit_logs (admin_id, action, entity_type, entity_id, metadata, ip)
  values (
    auth.uid(),
    v_action,
    coalesce(public.sanitized_text(p ->> 'entity_type', 60), ''),
    coalesce(public.sanitized_text(p ->> 'entity_id', 120), ''),
    case when jsonb_typeof(p -> 'metadata') = 'object' then p -> 'metadata' else '{}'::jsonb end,
    coalesce(public.sanitized_text(p ->> 'ip', 60), '')
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin RPC: real dashboard metrics
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview_stats(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(nullif(p ->> 'days', ''), '30')::integer, 1), 365);
  v_from timestamptz := now() - make_interval(days => v_days);
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with by_status as (
    select status, count(*)::int as count
    from public.applications
    group by status
  ),
  totals as (
    select count(*)::int as total from public.applications
  ),
  recent as (
    select count(*)::int as recent_count
    from public.applications
    where submitted_at >= v_from
  ),
  review as (
    select coalesce(round(avg(extract(epoch from (first_response_at - submitted_at)) / 60.0))::int, null) as avg_minutes,
           count(*)::int as reviewed_count
    from public.applications
    where first_response_at is not null
  ),
  daily as (
    select to_char(d, 'YYYY-MM-DD') as day,
           coalesce((select count(*) from public.applications a
                     where a.submitted_at >= d and a.submitted_at < d + interval '1 day'), 0)::int as count
    from generate_series((v_from)::date::timestamp, current_date::timestamp, interval '1 day') d
  )
  select jsonb_build_object(
    'total', totals.total,
    'by_status', coalesce((select jsonb_object_agg(status, count) from by_status), '{}'::jsonb),
    'period_days', v_days,
    'period_count', recent.recent_count,
    'avg_review_minutes', review.avg_minutes,
    'reviewed_count', review.reviewed_count,
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'count', count) order by day) from daily), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'reference', a.reference, 'full_name', a.full_name,
        'status', a.status, 'submitted_at', a.submitted_at, 'product_count', a.product_count
      ) order by a.submitted_at desc)
      from (
        select * from public.applications order by submitted_at desc limit 8
      ) a
    ), '[]'::jsonb)
  )
  into v_result
  from totals, recent, review;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Edge function helper: atomic rate limiting
-- ---------------------------------------------------------------------------
create or replace function public.bump_rate_limit(
  p_bucket text,
  p_key text,
  p_window_seconds integer,
  p_max integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if coalesce(p_bucket, '') !~ '^[a-z0-9_]{1,60}$'
     or coalesce(p_key, '') = '' or char_length(p_key) > 200
     or p_window_seconds not between 1 and 86400
     or p_max not between 1 and 100000 then
    raise exception 'invalid_payload' using errcode = 'P0001';
  end if;

  insert into public.rate_limits (bucket, key, window_start, count)
  values (p_bucket, p_key, now(), 1)
  on conflict (bucket, key) do update
    set count = case
          when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
            then 1
          else public.rate_limits.count + 1
        end,
        window_start = case
          when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
            then now()
          else public.rate_limits.window_start
        end
  returning count into v_count;

  if v_count > p_max then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  return v_count;
end;
$$;

revoke execute on function public.bump_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.bump_rate_limit(text, text, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
  admin_functions text[] := array[
    'save_application_settings(jsonb)',
    'save_form_fields(jsonb)',
    'update_application_status(jsonb)',
    'bulk_update_application_status(jsonb)',
    'assign_reviewer(jsonb)',
    'add_application_note(jsonb)',
    'register_terms_document(jsonb)',
    'publish_terms(jsonb)',
    'unpublish_terms(jsonb)',
    'delete_terms_document(jsonb)',
    'attach_application_document(jsonb)',
    'delete_application_document(jsonb)',
    'save_admin_preferences(jsonb)',
    'log_admin_action(jsonb)',
    'admin_overview_stats(jsonb)'
  ];
begin
  foreach f in array admin_functions
  loop
    execute format('revoke execute on function public.%s from public, anon;', f);
    execute format('grant execute on function public.%s to authenticated, service_role;', f);
  end loop;
end $$;
