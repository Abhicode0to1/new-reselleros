-- ============================================================================
-- Marketing Hub — the tools the business runs on, tracked links, and email opt-outs.
--
-- Pardeep, 26 Sep 2026: "marketing aur advertising ke jo tools mere paas hone chahiye,
-- unko use karne ka ek system banao". Phase 1 of that:
--
--   1. marketing_tools — one row per tool per company (Meta Ads Manager, Google Ads,
--      Google Business Profile, IndiaMART…): is it set up, where is the account, who runs
--      it, what is the monthly budget. The CATALOGUE of tools (name, why, how to use it
--      here) is code — src/lib/marketing/tool-catalog.ts — so improving the advice reaches
--      every company without a data migration. A row exists only once someone records
--      something; a tool with no row is "not started".
--
--   2. tracking_links — the UTM links made on Marketing → Tracking links, kept so the same
--      link is reused across a campaign and its leads can be counted
--      (leads.utm_campaign, captured by src/lib/marketing/utm.ts since migration 0232).
--
--   3. email_suppressions — addresses that clicked "unsubscribe" in a campaign email.
--      /api/campaigns/send skips them. Written by the public unsubscribe route through
--      the service role (the person unsubscribing is not signed in); readable by the
--      company so it can see who opted out.
-- ============================================================================

-- ── 1. marketing_tools ──────────────────────────────────────────────────────
create table if not exists public.marketing_tools (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  tool_key       text not null,
  name           text not null,
  status         text not null default 'not_started'
                 check (status in ('not_started', 'setting_up', 'active', 'paused', 'not_needed')),
  account_url    text,
  owner_name     text,
  monthly_budget integer not null default 0 check (monthly_budget >= 0),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, tool_key)
);

comment on table public.marketing_tools is
  'Per-company state of each marketing tool (catalogue in src/lib/marketing/tool-catalog.ts). No row = not started.';

alter table public.marketing_tools enable row level security;

drop policy if exists "tenant isolation read" on public.marketing_tools;
create policy "tenant isolation read" on public.marketing_tools
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.marketing_tools;
create policy "tenant isolation write" on public.marketing_tools
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation update" on public.marketing_tools;
create policy "tenant isolation update" on public.marketing_tools
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.marketing_tools;
create policy "tenant isolation delete" on public.marketing_tools
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.marketing_tools;
create policy zzz_service_role_all on public.marketing_tools
  as permissive for all to service_role using (true) with check (true);

-- ── 2. tracking_links ───────────────────────────────────────────────────────
create table if not exists public.tracking_links (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  label            text not null,
  channel          text not null,
  utm_medium       text not null,
  utm_campaign     text not null,
  utm_content      text,
  destination_path text not null,
  full_url         text not null,
  created_by       uuid,
  created_at       timestamptz not null default now()
);

comment on table public.tracking_links is
  'UTM links made on Marketing → Tracking links. utm_source is the channel key, so a lead from the link lands on that channel in ROAS & CAC.';

alter table public.tracking_links enable row level security;

drop policy if exists "tenant isolation read" on public.tracking_links;
create policy "tenant isolation read" on public.tracking_links
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation write" on public.tracking_links;
create policy "tenant isolation write" on public.tracking_links
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.tracking_links;
create policy "tenant isolation delete" on public.tracking_links
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.tracking_links;
create policy zzz_service_role_all on public.tracking_links
  as permissive for all to service_role using (true) with check (true);

create index if not exists tracking_links_tenant_idx on public.tracking_links (tenant_id, created_at desc);

-- ── 3. email_suppressions ───────────────────────────────────────────────────
create table if not exists public.email_suppressions (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null check (email = lower(trim(email)) and email <> ''),
  reason      text not null default 'unsubscribed',
  campaign_id text,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, email)
);

comment on table public.email_suppressions is
  'Addresses that opted out of campaign email. /api/campaigns/send skips them. Lower-cased, trimmed.';

alter table public.email_suppressions enable row level security;

/* The company can read its opt-outs and remove one (someone who asks to be put back).
   It cannot ADD one on a person's behalf from the browser — only the signed unsubscribe
   link does that, through the service role. */
drop policy if exists "tenant isolation read" on public.email_suppressions;
create policy "tenant isolation read" on public.email_suppressions
  for select to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.email_suppressions;
create policy "tenant isolation delete" on public.email_suppressions
  for delete to authenticated using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.email_suppressions;
create policy zzz_service_role_all on public.email_suppressions
  as permissive for all to service_role using (true) with check (true);
