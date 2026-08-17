-- 20260817160000_support_tier_skus
--
-- The three support plans, monthly and yearly, in every tenant's catalogue.
--
-- ─── THE YEARLY PRICE IS A TOTAL, AND IT LIVES IN prices.annual_total ───────
-- Everything else in `items` is priced per seat per MONTH, and the year is derived
-- as monthly × 12 (lib/subscriptions/catalog-options.ts). These plans are not:
-- Standard is ₹999/mo OR ₹9,996/yr — a real discount, not a different monthly rate.
-- Deriving the year from a monthly rate would simply lose the discount.
--
-- So the yearly SKUs carry `prices.annual_total.msrp`, read verbatim. It is a
-- SEPARATE key from `prices.annual`, which is a monthly rate under annual commitment;
-- overloading that one would leave two meanings behind a single name.
--
-- ─── AND THE YEARLY PRICES DIVIDE BY TWELVE, ON PURPOSE ─────────────────────
-- ₹9,996 and ₹49,992, not ₹9,990 and ₹49,990.
--
-- record_payment derives a subscription's mrr as round(line_amount / 12)
-- (baseline.sql:4580), so the term a subscription believes in is ALWAYS twelve whole
-- monthly rupees. A yearly price that does not divide comes back changed:
--
--   ₹9,990 ÷ 12 = ₹832.50 → mrr ₹833 → the subscription reads ₹9,996 while the quote
--   says ₹9,990. Six rupees, and two numbers for one plan on two screens — the
--   billing-schedule card and next year's renewal quote both disagree with the sale.
--
--   ₹9,996 ÷ 12 = ₹833 exactly → mrr × 12 is ₹9,996 → everything agrees.
--
-- Six rupees on the price buys the removal of a whole class of bug rather than a note
-- explaining it. The saving is unchanged at 17% and two months free, because the badge
-- is computed from the prices and not written down. Pardeep chose this on 17 Aug 2026
-- after the ±₹6 was put on the table.
--
-- ─── EVERY TENANT, NOT JUST ONE ─────────────────────────────────────────────
-- Inserted per tenant so the rows pass RLS for their owner. Ids are deterministic
-- (SUP-STANDARD-YR etc. prefixed by tenant) so re-running updates in place instead of
-- duplicating the catalogue.

begin;

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, item_type, kind, prices)
select
  sku.id_prefix || '-' || replace(t.id::text, '-', '') ,
  t.id,
  sku.name,
  'support'::public.vendor,
  '998313',
  sku.msrp,
  0,
  true,
  'subscription',
  'main',
  sku.prices
from public.tenants t
cross join (values
  -- id_prefix,            name,                            msrp (₹/mo), prices
  ('SUP-FREE-MO',       'Support Free (Monthly)',                0, '{}'::jsonb),
  ('SUP-FREE-YR',       'Support Free (Yearly)',                 0, '{}'::jsonb),
  ('SUP-STANDARD-MO',   'Support Standard (Monthly)',          999, '{}'::jsonb),
  ('SUP-STANDARD-YR',   'Support Standard (Yearly)',             0, '{"annual_total":{"msrp":9996,"wholesale":0}}'::jsonb),
  ('SUP-ENTERPRISE-MO', 'Support Enterprise (Monthly)',       4999, '{}'::jsonb),
  ('SUP-ENTERPRISE-YR', 'Support Enterprise (Yearly)',           0, '{"annual_total":{"msrp":49992,"wholesale":0}}'::jsonb)
) as sku(id_prefix, name, msrp, prices)
on conflict (id) do update
  set name      = excluded.name,
      msrp      = excluded.msrp,
      prices    = excluded.prices,
      is_active = true;

comment on column public.items.prices is
  'Per-seat price variants. `annual`/`monthly` hold MONTHLY rates; `annual_total` holds a whole-year TOTAL used verbatim, for plans whose yearly price is a DISCOUNT rather than a different monthly rate. See lib/subscriptions/catalog-options.ts.';

commit;
