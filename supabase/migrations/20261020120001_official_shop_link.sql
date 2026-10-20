-- 0009: Official shop destination.
-- The original store stays the single source of products — the platform only
-- links out to it and never hosts a product catalogue of its own.
-- The shop columns shipped with an empty URL and a legacy button label, and
-- there is no admin UI for them, so only untouched values are updated.

alter table public.application_settings
  alter column shop_url set default 'https://www.furtunaskin.com/collections/all';

alter table public.application_settings
  alter column shop_button_label set default 'Visit Shop';

update public.application_settings
set shop_url = 'https://www.furtunaskin.com/collections/all',
    updated_at = now()
where shop_url = '';

update public.application_settings
set shop_button_label = 'Visit Shop',
    updated_at = now()
where shop_button_label in ('Open Official Shop', '');
