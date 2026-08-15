-- ============================================================================
-- 0161 — Decouple BILLING CYCLE (invoice frequency) from line COMMITMENT (price tier)
--
-- Why: a quote line's `commitment` conflated two independent things — the PRICE
-- TIER (monthly-flex vs annual) and the BILLING FREQUENCY (yearly / half /
-- quarterly / monthly). Frequency is a QUOTE-level concern, not a per-product
-- price concern. This adds a dedicated quote-level `billing_cycle` so the two
-- are independent (and the builder's cycle picker no longer has to be gated on
-- line items existing).
--
-- MONEY-SAFE: this is additive + display-only. `record_payment` still keys the
-- "make a subscription?" decision off the line's price tier via its existing
-- `commitment is distinct from 'monthly'` gate (annual_yearly and a future bare
-- 'annual' both pass it); MRR/term math is unchanged. Frequency has never driven
-- real invoicing in the DB (see 0116 generate_invoice — it ignores commitment),
-- so no billing amounts change. Line `commitment` values are left untouched;
-- new quotes simply stop using the annual_quarterly/half/monthly *frequency*
-- variants and carry frequency in `billing_cycle` instead.
-- ============================================================================

alter table quotes
  add column if not exists billing_cycle text not null default 'yearly';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_billing_cycle_check'
  ) then
    alter table quotes
      add constraint quotes_billing_cycle_check
      check (billing_cycle in ('monthly', 'quarterly', 'half_yearly', 'yearly'));
  end if;
end $$;

-- Backfill existing quotes so their displayed frequency doesn't change. Derive
-- from the FIRST line item's commitment (the same line record_payment reads):
--   any flex-monthly line          → 'monthly'
--   annual_monthly                 → 'monthly'
--   annual_quarterly               → 'quarterly'
--   annual_half_yearly             → 'half_yearly'
--   annual_yearly / anything else  → 'yearly'
update quotes q
set billing_cycle = sub.cyc
from (
  select
    id,
    case (line_items -> 0 ->> 'commitment')
      when 'monthly'            then 'monthly'
      when 'annual_monthly'     then 'monthly'
      when 'annual_quarterly'   then 'quarterly'
      when 'annual_half_yearly' then 'half_yearly'
      else 'yearly'
    end as cyc
  from quotes
  where jsonb_typeof(line_items) = 'array'
    and jsonb_array_length(line_items) > 0
) sub
where q.id = sub.id
  and q.billing_cycle = 'yearly';   -- only touch rows still on the default
