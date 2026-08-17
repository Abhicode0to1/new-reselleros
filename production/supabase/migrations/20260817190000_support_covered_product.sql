-- 20260817190000_support_covered_product
--
-- Which product a support plan actually covers.
--
-- ─── WHY THIS IS A COLUMN AND NOT A GUESS FROM THE NAME ─────────────────────
-- A reseller sells support for Google Workspace, for Microsoft 365, or for
-- everything. Without somewhere to record that, "does this customer have support for
-- the product they are asking about?" can only be answered by reading the plan's
-- NAME — and the day someone renames a SKU, every entitlement answer changes with it.
--
-- ─── THE VALUES MATCH THE vendor ENUM ON PURPOSE ────────────────────────────
-- `subscriptions.vendor` is public.vendor (google / microsoft / zoho / hosting /
-- support / domain / other). Storing covered_product with the SAME spellings means
-- the entitlement check is a direct comparison rather than a mapping table that has
-- to be kept in step.
--
-- `all` is the extra value the enum does not have, which is why this is text with a
-- check rather than the enum itself — adding a value to a shared enum to serve one
-- column would change the meaning of `vendor` everywhere it is used.
--
-- ─── NULL MEANS "NOT RECORDED", NOT "COVERS EVERYTHING" ─────────────────────
-- Every non-support item is null, and so is any support SKU nobody has classified.
-- The entitlement code treats null as UNKNOWN and says so, rather than reading it as
-- `all` — a support plan silently covering products it was never sold for is how a
-- customer gets told they are entitled to something nobody agreed to.
--
-- ─── THE PLANS ARE NAMED AFTER THE TENANT, NOT AFTER US ─────────────────────
-- These SKUs live in each tenant's own catalogue. Hardcoding one reseller's brand
-- would put their name in every other reseller's product list, so the name is built
-- from `tenants.name`.

begin;

alter table public.items
  add column if not exists covered_product text;

alter table public.items
  drop constraint if exists items_covered_product_check;
alter table public.items
  add constraint items_covered_product_check
  check (covered_product is null
         or covered_product in ('google', 'microsoft', 'zoho', 'hosting', 'domain', 'other', 'all'));

comment on column public.items.covered_product is
  'For a support SKU: which product it covers. Same spellings as public.vendor so the entitlement check is a direct comparison, plus `all`. NULL = not recorded, which entitlement treats as UNKNOWN — never as `all`.';

/* Every support plan sold so far covers the whole stack. Stated explicitly rather
   than left null, because null means "nobody has said" and these have now been said. */
update public.items
   set covered_product = 'all'
 where id like 'SUP-%'
   and covered_product is null;

/* Branded with the reseller's own name. */
update public.items i
   set name = t.name || ' Standard Support'
  from public.tenants t
 where t.id = i.tenant_id and i.id like 'SUP-STANDARD-MO-%';

update public.items i
   set name = t.name || ' Standard Support (Yearly)'
  from public.tenants t
 where t.id = i.tenant_id and i.id like 'SUP-STANDARD-YR-%';

update public.items i
   set name = t.name || ' Enterprise Support'
  from public.tenants t
 where t.id = i.tenant_id and i.id like 'SUP-ENTERPRISE-MO-%';

update public.items i
   set name = t.name || ' Enterprise Support (Yearly)'
  from public.tenants t
 where t.id = i.tenant_id and i.id like 'SUP-ENTERPRISE-YR-%';

update public.items i
   set name = t.name || ' Free Support'
  from public.tenants t
 where t.id = i.tenant_id and i.id like 'SUP-FREE-MO-%';

update public.items i
   set name = t.name || ' Free Support (Yearly)'
  from public.tenants t
 where t.id = i.tenant_id and i.id like 'SUP-FREE-YR-%';

create index if not exists items_covered_product_idx
  on public.items (tenant_id, covered_product)
  where covered_product is not null;

commit;
