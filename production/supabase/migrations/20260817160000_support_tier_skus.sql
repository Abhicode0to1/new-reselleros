-- 20260817160000_support_tier_skus
--
-- The three support plans, monthly and yearly, in every tenant's catalogue.
--
-- ─── THE YEARLY PRICE IS A TOTAL, AND IT LIVES IN prices.annual_total ───────
-- Everything else in `items` is priced per seat per MONTH, and the year is derived
-- as monthly × 12 (lib/subscriptions/catalog-options.ts). These plans are not:
-- Standard is ₹999/mo OR ₹9,990/yr — a real discount, not a different monthly rate.
--
-- ₹9,990 ÷ 12 = ₹832.50, which is not a whole rupee (AGENTS.md §1). Forcing the year
-- through a monthly rate rounds to ₹833 and bills ₹9,996 — the customer quoted one
-- number and charged another.
--
-- So the yearly SKUs carry `prices.annual_total.msrp`, read verbatim. It is a
-- SEPARATE key from `prices.annual`, which is a monthly rate under annual commitment;
-- overloading that one would leave two meanings behind a single name.
--
-- ─── A KNOWN ±₹6, WRITTEN DOWN RATHER THAN HIDDEN ───────────────────────────
-- The quote and its invoice both carry ₹9,990 and are exact. But record_payment
-- derives the subscription's mrr as round(line_amount / 12) (baseline.sql:4580), and
-- ₹9,990 has no whole-rupee monthly form — so `subscriptions.mrr` lands on ₹833 and
-- mrr × 12 reads ₹9,996 on the billing-schedule card and on next year's renewal quote.
--
-- Six rupees on Standard, two on Enterprise. It is bounded and it is in one place, but
-- it is real: the schema can only express a term as twelve monthly rupees.
--
-- Pricing the year at ₹9,996 and ₹49,992 instead would remove it completely and still
-- be ~17% off. That is a commercial decision, so the figures below are the ones that
-- were asked for, and this note is here so the choice is a choice.
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
  ('SUP-STANDARD-YR',   'Support Standard (Yearly)',             0, '{"annual_total":{"msrp":9990,"wholesale":0}}'::jsonb),
  ('SUP-ENTERPRISE-MO', 'Support Enterprise (Monthly)',       4999, '{}'::jsonb),
  ('SUP-ENTERPRISE-YR', 'Support Enterprise (Yearly)',           0, '{"annual_total":{"msrp":49990,"wholesale":0}}'::jsonb)
) as sku(id_prefix, name, msrp, prices)
on conflict (id) do update
  set name      = excluded.name,
      msrp      = excluded.msrp,
      prices    = excluded.prices,
      is_active = true;

comment on column public.items.prices is
  'Per-seat price variants. `annual`/`monthly` hold MONTHLY rates; `annual_total` holds a whole-year TOTAL used verbatim (support plans, whose yearly price is a discount and does not divide by 12). See lib/subscriptions/catalog-options.ts.';

commit;
