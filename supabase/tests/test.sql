-- Functional + RLS test suite for the partnershipy schema (run against local Postgres shim).
\set ON_ERROR_STOP on
\timing off

create or replace function public.assert_true(cond boolean, label text)
returns void language plpgsql as $fn$
begin
  if cond is distinct from true then
    raise exception 'ASSERT FAILED: %', label;
  end if;
  raise notice 'PASS: %', label;
end $fn$;

create or replace function public.test_common_payload()
returns jsonb language sql stable as $fn$
  select jsonb_build_object(
    'full_name', 'Test Applicant', 'email', 'applicant@example.com',
    'phone', '+1 555 0100', 'country', 'United States', 'region', 'California',
    'address_street', '1 Test Street', 'address_city', 'Testville',
    'address_region', 'California', 'address_postal_code', '90001',
    'address_country', 'United States',
    'instagram_handle', 'testhandle', 'tiktok_handle', 'testhandle'
  );
$fn$;

-- ---------------------------------------------------------------- setup users
insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
       ('22222222-2222-2222-2222-222222222222', 'stranger@example.com')
on conflict do nothing;

insert into public.admin_profiles (id, email, full_name, role)
values ('11111111-1111-1111-1111-111111111111', 'owner@example.com', 'Ada Owner', 'owner')
on conflict (id) do nothing;

-- ---------------------------------------------------------- anon cannot read
set role anon;
select public.assert_true(
  (select count(*) from public.applications) = 0,
  'anon sees zero applications');
select public.assert_true(
  (select count(*) from public.application_notes) = 0,
  'anon sees zero notes');
select public.assert_true(
  (select count(*) from public.admin_preferences) = 0,
  'anon cannot read admin preferences');
select public.assert_true(
  (select count(*) from public.terms_documents) = 0,
  'anon cannot read terms documents');
select public.assert_true(
  (select count(*) from public.application_settings) = 1,
  'anon can read public settings');
select public.assert_true(
  (select count(*) from public.form_field_settings) >= 10,
  'anon can read form field settings');

-- anon cannot execute the submission function
do $$
begin
  begin
    perform public.finalize_application('{}'::jsonb);
    raise exception 'ASSERT FAILED: anon executed finalize_application';
  exception when insufficient_privilege then
    raise notice 'PASS: anon cannot execute finalize_application';
  end;
end $$;

-- anon storage write only inside temp/<token>/
do $$
begin
  begin
    insert into storage.objects (bucket_id, name)
    values ('product-uploads', 'temp/' || repeat('a', 32) || '/file1.jpg');
    raise notice 'PASS: anon can write temp upload (expected path)';
  exception when others then
    raise exception 'ASSERT FAILED: anon temp upload rejected: %', sqlerrm;
  end;

  begin
    insert into storage.objects (bucket_id, name) values ('product-uploads', 'applications/evil.jpg');
    raise exception 'ASSERT FAILED: anon wrote outside temp folder';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into storage.objects (bucket_id, name) values ('terms-docs', 'x.pdf');
    raise exception 'ASSERT FAILED: anon wrote to terms-docs';
  exception when insufficient_privilege then
    raise notice 'PASS: anon cannot write private buckets';
  end;
end $$;

reset role;

-- ------------------------------------------- admin: terms upload and publish
set role authenticated;
set request.jwt.claim.sub to '11111111-1111-1111-1111-111111111111';
set request.jwt.claim.role to 'authenticated';

select public.register_terms_document(jsonb_build_object(
  'title', 'Collaboration Terms & Conditions',
  'description', 'First published version',
  'version', 'v1.0',
  'storage_path', 'terms-docs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf',
  'file_size', 24000,
  'sha256', repeat('a', 64)
))::text as terms1 \gset

select public.publish_terms(jsonb_build_object(
  'id', ((:'terms1'::jsonb) ->> 'id')
))::text as published1 \gset

select public.assert_true(
  (:'published1'::jsonb) ->> 'status' = 'published'
    and (:'published1'::jsonb) ->> 'is_current' = 'true',
  'terms v1.0 published as current');

select public.register_terms_document(jsonb_build_object(
  'title', 'Collaboration Terms & Conditions',
  'version', 'v1.1',
  'storage_path', 'terms-docs/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.pdf',
  'file_size', 25000,
  'sha256', repeat('b', 64)
))::text as terms2 \gset

select public.publish_terms(jsonb_build_object(
  'id', ((:'terms2'::jsonb) ->> 'id')
))::text as published2 \gset

select public.assert_true(
  (select count(*) from public.terms_documents where is_current) = 1
    and (select is_current from public.terms_documents where id = ((:'terms2'::jsonb) ->> 'id')::uuid),
  'only newest terms version is current');

select public.assert_true(
  (select status from public.terms_documents where id = ((:'terms1'::jsonb) ->> 'id')::uuid) = 'published',
  'historical version remains stored as published (immutable history)');

-- duplicate version rejected
do $$
begin
  begin
    perform public.register_terms_document(jsonb_build_object(
      'title', 'x', 'version', 'v1.0',
      'storage_path', 'terms-docs/cccccccc-cccc-cccc-cccc-cccccccccccc.pdf',
      'file_size', 1000));
    raise exception 'ASSERT FAILED: duplicate version allowed';
  exception when others then
    if sqlerrm <> 'version_exists' then raise; end if;
    raise notice 'PASS: duplicate terms version rejected';
  end;
end $$;

-- ----------------------------------------------------- non-admin cannot write
set request.jwt.claim.sub to '22222222-2222-2222-2222-222222222222';
select public.assert_true(
  (select count(*) from public.applications) = 0,
  'non-admin authenticated sees no applications');
do $$
begin
  begin
    perform public.update_application_status(jsonb_build_object(
      'application_id', '00000000-0000-0000-0000-000000000000',
      'to_status', 'approved'));
    raise exception 'ASSERT FAILED: non-admin changed status';
  exception when others then
    if sqlerrm <> 'forbidden' then raise; end if;
    raise notice 'PASS: non-admin cannot change status';
  end;
end $$;

-- ------------------------------------------------------------- submission
reset role;
set role service_role;

select jsonb_build_object(
  'full_name', 'Test Applicant', 'email', 'applicant@example.com',
  'phone', '+1 555 0100', 'country', 'United States', 'region', 'California',
  'address_street', '1 Test Street', 'address_city', 'Testville',
  'address_region', 'California', 'address_postal_code', '90001',
  'address_country', 'United States',
  'instagram_handle', 'testhandle', 'tiktok_handle', 'testhandle'
) as common \gset


-- consent missing
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0001',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'No Consent', 'email', 'noconsent@example.com',
      'address_street', '1 Test St', 'address_city', 'Testville', 'address_country', 'UK',
      'instagram_handle', 'handle', 'tiktok_handle', 'handle',
      'terms_document_id', '00000000-0000-0000-0000-000000000000',
      'terms_version', 'v1.1', 'consent', false, 'terms_reviewed', false,
      'products', '[]'::jsonb));
    raise exception 'ASSERT FAILED: submission without consent succeeded';
  exception when others then
    if sqlerrm <> 'consent_required' then raise; end if;
    raise notice 'PASS: submission without consent rejected';
  end;
end $$;

-- wrong/outdated terms version
do $$
declare v_id uuid := gen_random_uuid();
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', v_id,
      'idempotency_key', 'test-idem-key-0002',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'Old Terms', 'email', 'oldterms@example.com',
      'address_street', '1 Test St', 'address_city', 'Testville', 'address_country', 'UK',
      'terms_document_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'terms_version', 'v1.0', 'terms_sha256', repeat('a', 64),
      'consent', true, 'terms_reviewed', true,
      'products', '[]'::jsonb));
    raise exception 'ASSERT FAILED: outdated terms accepted';
  exception when others then
    if sqlerrm <> 'terms_version_mismatch' then raise; end if;
    raise notice 'PASS: outdated terms version rejected';
  end;
end $$;

-- happy path
do $$
declare v_res jsonb;
begin
  v_res := public.finalize_application(public.test_common_payload() || jsonb_build_object(
    'application_id', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    'idempotency_key', 'test-idem-key-happy-01',
    'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
    'submission_ip', '203.0.113.10',
    'full_name', 'Cam Creator', 'email', 'cam@example.com', 'phone', '+44 7700 900123',
    'country', 'United Kingdom', 'region', 'Greater London',
    'address_street', '10 Example Road', 'address_city', 'London',
    'address_region', 'Greater London', 'address_postal_code', 'E1 6AN',
    'address_country', 'United Kingdom',
    'instagram_handle', '@cam.creates', 'tiktok_handle', 'camtik',
    'other_handles', '[{"platform": "YouTube", "handle": "@cam"}]'::jsonb,
    'portfolio_url', 'https://cam.example.com',
    'budget', '£500 per reel', 'payment_method', 'paypal',
    'terms_document_id', (select id from public.terms_documents where is_current),
    'terms_version', (select version from public.terms_documents where is_current),
    'terms_sha256', (select sha256 from public.terms_documents where is_current),
    'consent', true, 'terms_reviewed', true,
    'products', jsonb_build_array(
      jsonb_build_object('name', 'Barrier Cream', 'url', 'https://shop.example.com/p/1',
        'variant', '50ml', 'notes', 'Love this',
        'files', jsonb_build_array(jsonb_build_object(
          'storage_path', 'applications/dddddddd-dddd-dddd-dddd-dddddddddddd/products/ffffffff-ffff-ffff-ffff-ffffffffffff.jpg',
          'mime_type', 'image/jpeg', 'file_size', 204800, 'sha256', repeat('c', 64),
          'original_name', 'shot.jpg'))),
      jsonb_build_object('name', 'Cleanser', 'url', 'https://shop.example.com/p/2',
        'variant', '', 'notes', '', 'files', '[]'::jsonb)
    )));
  if v_res ->> 'reference' is null or v_res ->> 'duplicate' <> 'false' then
    raise exception 'ASSERT FAILED: happy path returned %', v_res;
  end if;
  if (v_res ->> 'product_count')::int <> 2 then
    raise exception 'ASSERT FAILED: product count %', v_res;
  end if;
  raise notice 'PASS: submission accepted (reference %)', v_res ->> 'reference';
end $$;

-- idempotent replay returns the same application
do $$
declare v_res jsonb; v_count int;
begin
  v_res := public.finalize_application(public.test_common_payload() || jsonb_build_object(
    'application_id', gen_random_uuid(),
    'idempotency_key', 'test-idem-key-happy-01',
    'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
    'full_name', 'Cam Creator', 'email', 'cam@example.com',
    'address_street', '10 Example Road', 'address_city', 'London', 'address_country', 'United Kingdom',
    'terms_document_id', (select id from public.terms_documents where is_current),
    'terms_version', (select version from public.terms_documents where is_current),
    'consent', true, 'terms_reviewed', true, 'products', '[]'::jsonb));
  if v_res ->> 'duplicate' <> 'true' then
    raise exception 'ASSERT FAILED: replay not detected: %', v_res;
  end if;
  select count(*) into v_count from public.applications where idempotency_key = 'test-idem-key-happy-01';
  if v_count <> 1 then
    raise exception 'ASSERT FAILED: duplicate application created';
  end if;
  raise notice 'PASS: idempotent replay returns existing application';
end $$;

-- missing required field (email disabled cannot bypass core checks)
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0003',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'No Email', 'email', 'not-an-email',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', (select id from public.terms_documents where is_current),
      'terms_version', (select version from public.terms_documents where is_current),
      'consent', true, 'terms_reviewed', true, 'products', '[]'::jsonb));
    raise exception 'ASSERT FAILED: invalid email accepted';
  exception when others then
    if sqlerrm <> 'invalid_field:email' then raise; end if;
    raise notice 'PASS: invalid email rejected server-side';
  end;
end $$;

-- invalid storage path rejected
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0004',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'Evil Paths', 'email', 'evil@example.com',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', (select id from public.terms_documents where is_current),
      'terms_version', (select version from public.terms_documents where is_current),
      'consent', true, 'terms_reviewed', true,
      'products', jsonb_build_array(jsonb_build_object(
        'name', 'x',
        'files', jsonb_build_array(jsonb_build_object(
          'storage_path', 'temp/aabbccdd-1122-3344-5566-77889900aabb/steal.jpg',
          'mime_type', 'image/jpeg', 'file_size', 1000))))));
    raise exception 'ASSERT FAILED: temp path accepted as final path';
  exception when others then
    if sqlerrm <> 'invalid_upload_path' then raise; end if;
    raise notice 'PASS: non-final storage path rejected';
  end;
end $$;

-- unsafe URL rejected
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0005',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'Bad Url', 'email', 'badurl@example.com',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', (select id from public.terms_documents where is_current),
      'terms_version', (select version from public.terms_documents where is_current),
      'consent', true, 'terms_reviewed', true,
      'products', jsonb_build_array(jsonb_build_object(
        'name', 'x', 'url', 'javascript:alert(1)'))));
    raise exception 'ASSERT FAILED: javascript: URL accepted';
  exception when others then
    if sqlerrm <> 'invalid_url' then raise; end if;
    raise notice 'PASS: unsafe product URL rejected';
  end;
end $$;

-- paused applications
update public.application_settings set applications_paused = true where id;
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0006',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'Paused', 'email', 'paused@example.com',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', (select id from public.terms_documents where is_current),
      'terms_version', (select version from public.terms_documents where is_current),
      'consent', true, 'terms_reviewed', true, 'products', '[]'::jsonb));
    raise exception 'ASSERT FAILED: paused applications accepted';
  exception when others then
    if sqlerrm <> 'applications_paused' then raise; end if;
    raise notice 'PASS: paused applications rejected';
  end;
end $$;
update public.application_settings set applications_paused = false where id;

-- max products in payload > 30
do $$
declare v_products jsonb := '[]'::jsonb; i int;
begin
  for i in 1..31 loop
    v_products := v_products || jsonb_build_array(jsonb_build_object('name', 'p' || i));
  end loop;
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0007',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'Too Many', 'email', 'toomany@example.com',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', (select id from public.terms_documents where is_current),
      'terms_version', (select version from public.terms_documents where is_current),
      'consent', true, 'terms_reviewed', true, 'products', v_products));
    raise exception 'ASSERT FAILED: 31 products accepted';
  exception when others then
    if sqlerrm <> 'max_products' then raise; end if;
    raise notice 'PASS: product payload above 30 rejected';
  end;
end $$;

-- ------------------------------------------------------------- storage limit
do $$
declare i int;
begin
  insert into public.applications (
    id, reference, idempotency_key, full_name, email,
    address_street, address_city, address_country,
    terms_document_id, terms_version, terms_accepted_at
  ) values (
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'CPA-TEST01', 'test-idem-limit-01',
    'Limit Tester', 'limit@example.com', '1 St', 'Town', 'US',
    (select id from public.terms_documents where is_current),
    (select version from public.terms_documents where is_current), now()
  );

  for i in 1..30 loop
    insert into public.application_products (application_id, position, name)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', i, 'direct ' || i);
  end loop;

  begin
    insert into public.application_products (application_id, position, name)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 31, 'extra');
    raise exception 'ASSERT FAILED: 31st product insert allowed';
  exception when others then
    if sqlerrm <> 'max_products' then raise; end if;
    raise notice 'PASS: 31st product insert blocked by trigger';
  end;

  if (select product_count from public.applications where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') <> 30 then
    raise exception 'ASSERT FAILED: product_count not maintained';
  end if;
  raise notice 'PASS: product_count maintained by trigger';

  delete from public.applications where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
end $$;

-- min product enforcement
update public.application_settings set min_products = 2, max_products = 30 where id;
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0008',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'Below Min', 'email', 'min@example.com',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', (select id from public.terms_documents where is_current),
      'terms_version', (select version from public.terms_documents where is_current),
      'consent', true, 'terms_reviewed', true, 'products', '[]'::jsonb));
    raise exception 'ASSERT FAILED: below min products accepted';
  exception when others then
    if sqlerrm <> 'min_products' then raise; end if;
    raise notice 'PASS: minimum product count enforced';
  end;
end $$;
update public.application_settings set min_products = 0 where id;

-- ------------------------------------------------------------ admin workflows
reset role;
set role authenticated;
set request.jwt.claim.sub to '11111111-1111-1111-1111-111111111111';

select public.assert_true(
  (select count(*) from public.applications) >= 1,
  'admin can read applications');

select public.assert_true(
  (select count(*) from public.application_products) >= 0
    and (select count(*) from public.application_product_files) >= 1,
  'admin can read products and files');

select public.assert_true(
  (select count(*) from public.admin_audit_logs) >= 1,
  'audit log written for admin actions');

select (public.update_application_status(jsonb_build_object(
  'application_id', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'to_status', 'under_review')))::text as status_update \gset

select public.assert_true(
  (:'status_update'::jsonb) ->> 'status' = 'under_review'
    and (:'status_update'::jsonb) ->> 'first_response_at' is not null,
  'status change persisted with first response timestamp');

select public.assert_true(
  (select count(*) from public.application_status_history
   where application_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
     and to_status = 'under_review') = 1,
  'status history recorded');

select public.assert_true(
  (select count(*) from public.admin_audit_logs
   where action = 'application.status_change') >= 1,
  'status change audited');

select (public.add_application_note(jsonb_build_object(
  'application_id', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'body', 'Internal-only note')))::text as note \gset

select public.assert_true(
  (select count(*) from public.application_notes) = 1,
  'admin note stored');

select (public.admin_overview_stats('{"days": 30}'::jsonb))::text as stats \gset
select public.assert_true(
  (:'stats'::jsonb) ->> 'total' is not null
    and (:'stats'::jsonb) -> 'by_status' ? 'under_review',
  'overview stats computed from real rows');

-- settings validation
do $$
begin
  begin
    perform public.save_application_settings(jsonb_build_object(
      'shop_url', 'javascript:alert(1)'));
    raise exception 'ASSERT FAILED: javascript shop url accepted';
  exception when others then
    if sqlerrm not like 'invalid_field:%' and sqlerrm not like 'unsafe_content%' then raise; end if;
    raise notice 'PASS: unsafe shop URL rejected';
  end;
  begin
    perform public.save_application_settings(jsonb_build_object('max_products', 42));
    raise exception 'ASSERT FAILED: max_products > 30 accepted';
  exception when others then
    if sqlerrm <> 'invalid_product_limits' then raise; end if;
    raise notice 'PASS: product max above 30 rejected';
  end;
  begin
    perform public.save_application_settings(jsonb_build_object(
      'welcome_heading', '<script>alert(1)</script>'));
    raise exception 'ASSERT FAILED: script content accepted';
  exception when others then
    if sqlerrm not like 'unsafe_content%' then raise; end if;
    raise notice 'PASS: script content rejected';
  end;
end $$;

select (public.save_application_settings(jsonb_build_object(
  'shop_url', 'https://shop.example.com/',
  'shop_button_label', 'Visit the shop',
  'primary_color', '#123456')))::text as saved_settings \gset
select public.assert_true(
  (:'saved_settings'::jsonb) ->> 'shop_url' = 'https://shop.example.com/',
  'valid settings saved');

-- form builder: locked fields stay enabled + required
select public.save_form_fields(jsonb_build_array(
  jsonb_build_object('field_key', 'email', 'enabled', false, 'required', false,
                     'label', 'Email address'),
  jsonb_build_object('field_key', 'phone', 'enabled', false, 'required', false)))::text as fields \gset
select public.assert_true(
  (select enabled and required from public.form_field_settings where field_key = 'email'),
  'locked field cannot be disabled');
select public.assert_true(
  (select enabled from public.form_field_settings where field_key = 'phone') = false,
  'non-locked field can be disabled');

-- restore phone for later tests
select public.save_form_fields(jsonb_build_array(
  jsonb_build_object('field_key', 'phone', 'enabled', true, 'required', true))) as restored;

-- current terms version cannot be deleted
do $$
begin
  begin
    perform public.delete_terms_document(jsonb_build_object(
      'id', (select id from public.terms_documents where is_current)));
    raise exception 'ASSERT FAILED: current terms deleted';
  exception when others then
    if sqlerrm <> 'is_current' then raise; end if;
    raise notice 'PASS: current terms version cannot be deleted';
  end;
end $$;

-- unreferenced historical version can be deleted
select public.delete_terms_document(jsonb_build_object(
  'id', (select id from public.terms_documents where version = 'v1.0')))::text as deleted_v10 \gset
select public.assert_true(
  (select count(*) from public.terms_documents where version = 'v1.0') = 0,
  'unreferenced historical terms version deleted');

-- unpublish current terms stops submissions
select public.unpublish_terms(jsonb_build_object(
  'id', (select id from public.terms_documents where is_current)))::text as unpublished \gset

-- a version referenced by an application can never be deleted
do $$
begin
  begin
    perform public.delete_terms_document(jsonb_build_object(
      'id', (select id from public.terms_documents limit 1)));
    raise exception 'ASSERT FAILED: referenced terms deleted';
  exception when others then
    if sqlerrm <> 'terms_in_use' then raise; end if;
    raise notice 'PASS: terms referenced by an application cannot be deleted';
  end;
end $$;
reset role;
set role service_role;
do $$
begin
  begin
    perform public.finalize_application(public.test_common_payload() || jsonb_build_object(
      'application_id', gen_random_uuid(),
      'idempotency_key', 'test-idem-key-0009',
      'upload_token', 'aabbccdd-1122-3344-5566-77889900aabb',
      'full_name', 'No Terms', 'email', 'noterms@example.com',
      'address_street', '1 St', 'address_city', 'Town', 'address_country', 'US',
      'terms_document_id', gen_random_uuid(), 'terms_version', 'v1.1',
      'consent', true, 'terms_reviewed', true, 'products', '[]'::jsonb));
    raise exception 'ASSERT FAILED: submission accepted without published terms';
  exception when others then
    if sqlerrm <> 'terms_unavailable' then raise; end if;
    raise notice 'PASS: no published terms blocks submissions';
  end;
end $$;

-- notes must not be readable by anon (already asserted) and status must persist
select public.assert_true(
  (select status from public.applications where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd') = 'under_review',
  'application status persisted');

select public.assert_true(
  (select count(*) from public.admin_profiles where is_active) = 1,
  'admin profile present');

reset role;
select 'ALL TESTS PASSED' as result;
