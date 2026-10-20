-- 0005: Storage buckets and object policies
-- Buckets:
--   * product-uploads : private. Temp applicant uploads under temp/<token>/, final files
--                       under applications/<application_id>/products/
--   * terms-docs      : private. Immutable Terms & Conditions PDFs (terms-docs/<uuid>.pdf)
--   * application-docs: private. Supporting/generated documents
--   * branding        : public. Logo / brand assets (public-safe branding only)
-- Anonymous uploads are only possible through short-lived signed upload URLs created by
-- the prepare-upload edge function (rate limited, size and MIME validated).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-uploads', 'product-uploads', false, 8388608,
     array['image/jpeg', 'image/png', 'image/webp']),
  ('terms-docs', 'terms-docs', false, 26214400, array['application/pdf']),
  ('application-docs', 'application-docs', false, 26214400, null),
  ('branding', 'branding', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Private buckets: administrator access only
-- ---------------------------------------------------------------------------
drop policy if exists "admins_read_private_uploads" on storage.objects;
create policy "admins_read_private_uploads" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('product-uploads', 'terms-docs', 'application-docs')
    and public.is_admin()
  );

drop policy if exists "admins_insert_private_uploads" on storage.objects;
create policy "admins_insert_private_uploads" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('product-uploads', 'terms-docs', 'application-docs', 'branding')
    and public.is_admin()
  );

drop policy if exists "admins_update_private_uploads" on storage.objects;
create policy "admins_update_private_uploads" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('product-uploads', 'terms-docs', 'application-docs', 'branding')
    and public.is_admin()
  )
  with check (
    bucket_id in ('product-uploads', 'terms-docs', 'application-docs', 'branding')
    and public.is_admin()
  );

drop policy if exists "admins_delete_private_uploads" on storage.objects;
create policy "admins_delete_private_uploads" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('product-uploads', 'terms-docs', 'application-docs', 'branding')
    and public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- Anonymous applicant uploads:
--   * inserts restricted to temp/<token>/<file> in the product-uploads bucket
--   * no anonymous SELECT (draft previews use short-lived signed URLs from an edge function)
-- ---------------------------------------------------------------------------
drop policy if exists "anon_insert_temp_product_uploads" on storage.objects;
create policy "anon_insert_temp_product_uploads" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'product-uploads'
    and (storage.foldername(name))[1] = 'temp'
    and coalesce(array_length(storage.foldername(name), 1), 0) = 2
    and (storage.filename(name)) ~ '^[A-Za-z0-9._-]{1,80}$'
  );

-- ---------------------------------------------------------------------------
-- Public branding assets
-- ---------------------------------------------------------------------------
drop policy if exists "public_read_branding" on storage.objects;
create policy "public_read_branding" on storage.objects
  for select to anon
  using (bucket_id = 'branding');
