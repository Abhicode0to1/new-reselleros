-- 0074_customer_domains.sql
-- A customer can own MANY domains (each a separate Google Workspace / subscription).
-- customers.domain holds only one "primary website", which fragments matching when a
-- customer has several domains. customer_domains is the many-to-one map used to link
-- Google subscriptions (keyed by domain) to the RIGHT existing customer — so one
-- customer with 5 domains stays ONE customer with 5 subscriptions, not 5 customers.
--
-- Sources that populate it: (1) every existing subscription's domain (backfilled
-- below), (2) a Zoho bridge import (customer_number -> domain, many rows per customer).
create table if not exists public.customer_domains (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  domain      text not null,
  created_at  timestamptz not null default now()
);

-- A domain belongs to at most ONE customer per tenant (no ambiguous links).
create unique index if not exists customer_domains_tenant_domain_unique
  on public.customer_domains (tenant_id, lower(domain));
create index if not exists customer_domains_customer_idx
  on public.customer_domains (customer_id);

alter table public.customer_domains enable row level security;

drop policy if exists "customer_domains_tenant" on public.customer_domains;
create policy "customer_domains_tenant"
  on public.customer_domains for all
  to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Backfill from existing subscriptions (each sub's domain -> its customer).
insert into public.customer_domains (tenant_id, customer_id, domain)
select distinct s.tenant_id, s.customer_id, lower(trim(s.domain))
from public.subscriptions s
where s.domain is not null and trim(s.domain) <> '' and s.customer_id is not null
on conflict (tenant_id, lower(domain)) do nothing;
