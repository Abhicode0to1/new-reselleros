-- Ad platform spend, fetched from Google Ads and Meta (Facebook / Instagram) Ads (27 Sep 2026).
--
-- Until now every ad rupee reached the app by hand: an expense row, tagged with a channel,
-- typed from the platform's invoice weeks after the money was spent. ROAS & CAC was only as
-- current as the last typed bill. The platforms know the spend to the day and the campaign,
-- so the app now asks them nightly.
--
--   ad_accounts     — one row per ad account the connected login can see (per platform).
--                     Meta's token lives here (per tenant, long-lived, ~60 days); Google Ads
--                     uses the connecting user's user_google_tokens row (scope adwords).
--   ad_spend_daily  — one row per (account, day, campaign): spend, impressions, clicks,
--                     conversions, in the account's currency. Re-fetched for the last 35 days
--                     on every sync because both platforms restate recent days.
--   ad_sync_runs    — every sync, with counts and the reason it failed.
--
-- Deliberately NOT expenses. The accountant's expense row is the bill that was paid and is
-- reconciled to the bank; the platform's number is what was consumed day by day. Both are
-- true and they differ (GST, prepaid top-ups, invoice timing). The page shows them side by
-- side; ROAS & CAC keeps the books as its source and names the gap when they disagree.
-- Server-written (service role); authenticated users read. The only user-side write is
-- the `enabled` flag, and that goes through the API route.

create table if not exists public.ad_accounts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  platform           text not null check (platform in ('google-ads', 'meta-ads')),
  account_id         text not null,                       -- Google customer id (digits) / Meta act_… id
  name               text not null,
  currency           text not null default 'INR',
  login_customer_id  text,                                -- Google: manager (MCC) id to send as login-customer-id
  connected_user_id  uuid references auth.users(id) on delete set null,
  access_token       text,                                -- Meta only (long-lived user token)
  token_expires_at   timestamptz,
  enabled            boolean not null default true,
  last_synced_at     timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, platform, account_id)
);

create table if not exists public.ad_spend_daily (
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  ad_account_id    uuid not null references public.ad_accounts(id) on delete cascade,
  day              date not null,
  campaign_id      text not null,
  campaign_name    text not null,
  spend            numeric(14,2) not null default 0 check (spend >= 0),
  impressions      integer not null default 0 check (impressions >= 0),
  clicks           integer not null default 0 check (clicks >= 0),
  conversions      numeric(12,2) not null default 0 check (conversions >= 0),
  conversion_value numeric(14,2) not null default 0 check (conversion_value >= 0),
  primary key (ad_account_id, day, campaign_id)
);

create table if not exists public.ad_sync_runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  trigger      text not null check (trigger in ('manual', 'cron', 'connect')),
  accounts     integer not null default 0,
  rows_written integer not null default 0,
  ok           boolean,
  error        text
);

do $$
declare t text;
begin
  foreach t in array array['ad_accounts', 'ad_spend_daily', 'ad_sync_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "tenant isolation read" on public.%I', t);
    execute format('create policy "tenant isolation read" on public.%I for select to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

create index if not exists ad_spend_daily_tenant_day_idx on public.ad_spend_daily (tenant_id, day);
create index if not exists ad_sync_runs_tenant_idx on public.ad_sync_runs (tenant_id, started_at desc);

-- Never let a browser read a Meta token. A column-level REVOKE does nothing while the
-- table-level SELECT (Supabase default) stands, so: drop the table grant, re-grant every
-- column except the token. Browser code must name its columns (no select *).
revoke select on public.ad_accounts from authenticated, anon;
grant select (id, tenant_id, platform, account_id, name, currency, login_customer_id, connected_user_id, token_expires_at, enabled, last_synced_at, last_error, created_at, updated_at)
  on public.ad_accounts to authenticated;

comment on table public.ad_accounts is 'Google Ads / Meta Ads accounts connected by a tenant; Meta token stored here (column hidden from authenticated).';
comment on table public.ad_spend_daily is 'Platform-reported daily spend per campaign, in account currency — the platform truth beside the books.';
