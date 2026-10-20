-- 0010: BYOMA rebrand — the platform takes on its final name.
-- Mirrors 0008: force-update rows still holding an older platform name,
-- never clobbering an administrator's custom brand name. Public copy that
-- still embeds the old name is rewritten in place so pages, emails and the
-- browser title stay consistent with the BYOMA logo shipped in assets/.

alter table public.application_settings
  alter column brand_name set default 'BYOMA';

update public.application_settings
set brand_name = 'BYOMA',
    updated_at = now()
where brand_name in ('Fortuna Skin', 'Furtuna Skin', 'Creator Partnerships');

update public.application_settings
set welcome_heading          = replace(replace(welcome_heading, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    welcome_description      = replace(replace(welcome_description, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    application_instructions = replace(replace(application_instructions, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    footer_text              = replace(replace(footer_text, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    success_message          = replace(replace(success_message, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    response_time_message    = replace(replace(response_time_message, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    product_instructions     = replace(replace(product_instructions, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    closure_message          = replace(replace(closure_message, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    shop_name                = replace(replace(shop_name, 'Furtuna Skin', 'BYOMA'), 'Fortuna Skin', 'BYOMA'),
    updated_at               = now()
where welcome_heading ~ 'Furtuna Skin|Fortuna Skin'
   or welcome_description ~ 'Furtuna Skin|Fortuna Skin'
   or application_instructions ~ 'Furtuna Skin|Fortuna Skin'
   or footer_text ~ 'Furtuna Skin|Fortuna Skin'
   or success_message ~ 'Furtuna Skin|Fortuna Skin'
   or response_time_message ~ 'Furtuna Skin|Fortuna Skin'
   or product_instructions ~ 'Furtuna Skin|Fortuna Skin'
   or closure_message ~ 'Furtuna Skin|Fortuna Skin'
   or shop_name ~ 'Furtuna Skin|Fortuna Skin';
