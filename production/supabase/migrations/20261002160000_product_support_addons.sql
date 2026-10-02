-- ============================================================================
-- Product-wise support add-ons — 2 Oct 2026.
--
-- Pardeep: "supprt add ons is tarah banao jaise google workspace business starter
-- support". One support add-on per main licence product, named "<product> Support",
-- monthly ₹999 and yearly ₹9,996 (the Standard tier price; he chose "abhi Standard
-- wala hi" — editable per item on /items).
--
-- Ids: SUP-<product id>-MO / -YR. The SUP- prefix is what the quote builder reads as
-- "our own service" (lib/support/tiers.ts isSupportSkuId); the tenant tier SKUs are
-- SUP-<TIER>-MO-<tenant>, so the two never collide.
--
-- covered_product = the product's vendor (google / microsoft / zoho), so entitlement
-- knows what the add-on covers. The tier is read from the name: a name ending in
-- "Support" is Standard (tierFromPlanName) — shipped before this data.
--
-- Data only, idempotent: re-running updates in place and never touches a price an
-- operator has since edited (on conflict leaves msrp/prices alone).
-- ============================================================================
begin;

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active,
                          item_type, kind, prices, covered_product)
select 'SUP-' || p.id || '-' || c.suffix,
       p.tenant_id,
       p.name || c.label,
       'support'::public.vendor,
       '998313',
       c.msrp,
       0,
       true,
       'subscription',
       'addon',
       c.prices,
       p.vendor::text
  from public.items p
 cross join (values
   ('MO', ' Support',          999, '{}'::jsonb),
   ('YR', ' Support (Yearly)',   0, '{"annual_total":{"msrp":9996,"wholesale":0}}'::jsonb)
 ) as c(suffix, label, msrp, prices)
 where p.kind = 'main'
   and p.item_type = 'subscription'
   and p.vendor in ('google', 'microsoft', 'zoho')
   and p.is_active
on conflict (id) do update
   set name            = excluded.name,
       kind            = 'addon',
       covered_product = excluded.covered_product,
       is_active       = true;

commit;
