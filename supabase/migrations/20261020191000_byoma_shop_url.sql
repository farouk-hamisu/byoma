-- 0011: BYOMA shop destination.
-- 0009 shipped the legacy store URL as the shop_url default and filled
-- untouched rows with it; the BYOMA rebrand (0010) covered platform names
-- only. Point the default and any still-legacy rows at the BYOMA shop.
-- Never clobbers an administrator-configured shop_url.

alter table public.application_settings
  alter column shop_url set default 'https://byoma.com/collections/all';

update public.application_settings
set shop_url = 'https://byoma.com/collections/all',
    updated_at = now()
where shop_url in ('', 'https://www.furtunaskin.com/collections/all');
