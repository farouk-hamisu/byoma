-- 0007: Remove the standalone Country / State fields and Preferred Payment Method
-- from the applicant form.
--
-- Location details are requested exactly once, inside the delivery-address block
-- (address_region / address_country). The Preferred Payment Method field is retired.
-- The applications.country / .region / .payment_method columns are kept so any
-- previously submitted data remains intact; they simply stop being collected.

delete from public.form_field_settings
where field_key in ('country', 'region', 'payment_method');

-- Renumber the remaining step-1 fields so positions stay contiguous.
with ordered as (
  select field_key, row_number() over (order by position) as rn
  from public.form_field_settings
  where step = 1
)
update public.form_field_settings f
set position = o.rn
from ordered o
where f.field_key = o.field_key and f.step = 1;

-- Clarify the add-platform helper copy.
update public.form_field_settings
set label = 'Other social platforms',
    helper_text = 'Add your @username or profile URL for each platform you create on.'
where field_key = 'other_handles';
