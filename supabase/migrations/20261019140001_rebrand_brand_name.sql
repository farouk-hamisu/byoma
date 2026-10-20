-- 0008: Fortuna Skin rebrand — the settings seed (0006) only inserts the row
-- when missing, so a project that already carried the pre-rebrand platform
-- name keeps it. Force-update only rows still holding the old value; this
-- never clobbers an administrator's custom brand name.
update public.application_settings
set brand_name = 'Fortuna Skin',
    updated_at = now()
where brand_name = 'Creator Partnerships';
