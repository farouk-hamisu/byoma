-- 0006: Seed configuration (no fabricated applications or metrics)
-- Safe to re-run: every statement is guarded with ON CONFLICT DO NOTHING.

insert into public.application_settings (id)
values (true)
on conflict (id) do nothing;

insert into public.admin_preferences (id)
values (true)
on conflict (id) do nothing;

insert into public.form_field_settings
  (field_key, label, placeholder, helper_text, step, position, enabled, required, locked, field_type, options)
values
  -- Step 1: personal information & delivery
  ('full_name', 'Full name', 'Your full name', '', 1, 1, true, true, true, 'text', '{}'::jsonb),
  ('email', 'Email address', 'you@example.com', 'We will only use this to contact you about your application.', 1, 2, true, true, true, 'email', '{}'::jsonb),
  ('phone', 'Phone number', '+44 7700 900000', 'Include your country code.', 1, 3, true, true, false, 'tel', '{}'::jsonb),
  ('address_street', 'Street address', '123 Example Street', '', 1, 4, true, true, true, 'text', '{}'::jsonb),
  ('address_line2', 'Apartment, suite, etc.', '', 'Optional.', 1, 5, true, false, false, 'text', '{}'::jsonb),
  ('address_city', 'City / Locality', '', '', 1, 6, true, true, true, 'text', '{}'::jsonb),
  ('address_region', 'State / Province / Region', '', 'Where applicable.', 1, 7, true, false, false, 'text', '{}'::jsonb),
  ('address_postal_code', 'Postal code', '', 'Where applicable — leave empty if not used.', 1, 8, true, false, false, 'text', '{}'::jsonb),
  ('address_country', 'Country', '', 'Country you live in.', 1, 9, true, true, true, 'country', '{}'::jsonb),
  -- Step 2: social media & creator information
  ('instagram_handle', 'Instagram handle', '@yourhandle', 'With or without the @ symbol.', 2, 1, true, true, false, 'text', '{}'::jsonb),
  ('tiktok_handle', 'TikTok handle', '@yourhandle', 'With or without the @ symbol.', 2, 2, true, true, false, 'text', '{}'::jsonb),
  ('other_handles', 'Other social platforms', '', 'Add your @username or profile URL for each platform you create on.', 2, 3, true, false, false, 'handles', '{}'::jsonb),
  ('portfolio_url', 'Portfolio URL', 'https://', 'Your website, media kit, or link hub.', 2, 4, true, false, false, 'url', '{}'::jsonb),
  ('budget', 'Typical rate / budget', '', 'Optional — share your usual rate for collaborations.', 2, 5, true, false, false, 'text', '{}'::jsonb)
on conflict (field_key) do nothing;
