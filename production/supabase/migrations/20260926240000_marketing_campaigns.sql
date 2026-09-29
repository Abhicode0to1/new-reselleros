-- ============================================================================
-- Marketing campaigns — a budget, dates and a target, with spend and leads tied to it.
--
-- Phase 3 (Pardeep, 26 Sep 2026): "Diwali offer: ₹20,000, 1–31 Oct, 30 leads" as one
-- thing the app can track, instead of a number in someone's head.
--
--   1. marketing_campaigns — name, code, start / end, budget, targets (leads, deals), notes.
--      `code` is the utm_campaign value: tracking links made for the campaign carry it
--      (lib/marketing/tracking-link.ts slugs to the same shape), and a lead that arrives
--      through one has leads.utm_campaign = code. So leads join by code, with no new column
--      on leads (Abhishek / public-form routes stay untouched).
--   2. expenses.campaign_id — a marketing expense (or a Facebook invoice booked from an
--      advance) can be put against a campaign. ON DELETE SET NULL: deleting a campaign
--      must never delete money that left the bank.
--
-- Not called "campaigns": that table is the email campaigns (/campaigns) and stays so.
-- ============================================================================

create table if not exists public.marketing_campaigns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null check (char_length(trim(name)) between 2 and 120),
  code          text not null check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(code) <= 60),
  start_date    date not null,
  end_date      date not null,
  budget        integer not null default 0 check (budget >= 0),
  target_leads  integer check (target_leads is null or target_leads >= 0),
  target_won    integer check (target_won is null or target_won >= 0),
  cancelled     boolean not null default false,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint marketing_campaigns_dates check (end_date >= start_date),
  unique (tenant_id, code)
);

comment on table public.marketing_campaigns is
  'Marketing campaign: dates, budget, targets. code = utm_campaign, so tracking-link leads join by it; spend joins by expenses.campaign_id.';

alter table public.marketing_campaigns enable row level security;

drop policy if exists "tenant isolation read" on public.marketing_campaigns;
create policy "tenant isolation read" on public.marketing_campaigns
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.marketing_campaigns;
create policy "tenant isolation write" on public.marketing_campaigns
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation update" on public.marketing_campaigns;
create policy "tenant isolation update" on public.marketing_campaigns
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.marketing_campaigns;
create policy "tenant isolation delete" on public.marketing_campaigns
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.marketing_campaigns;
create policy zzz_service_role_all on public.marketing_campaigns
  as permissive for all to service_role using (true) with check (true);

-- ── expenses.campaign_id ────────────────────────────────────────────────────
alter table public.expenses
  add column if not exists campaign_id uuid references public.marketing_campaigns(id) on delete set null;

create index if not exists expenses_campaign_idx on public.expenses (tenant_id, campaign_id) where campaign_id is not null;

/* An expense may only point at a campaign of its own company — the FK alone would accept
   another tenant's campaign id typed into an API call. */
create or replace function public.tg_expense_campaign_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.campaign_id is not null and not exists (
    select 1 from public.marketing_campaigns c where c.id = new.campaign_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'Campaign not found for this company.';
  end if;
  return new;
end $$;

drop trigger if exists trg_expense_campaign_same_tenant on public.expenses;
create trigger trg_expense_campaign_same_tenant
  before insert or update of campaign_id on public.expenses
  for each row execute function public.tg_expense_campaign_same_tenant();
