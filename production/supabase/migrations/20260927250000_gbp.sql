-- Google Business Profile (GBP) — the company's Google listing, in the app (27 Sep 2026).
--
-- "IT company near me" is won or lost on the Google listing: how often it appears on Maps
-- and Search, how many people call / ask directions / open the website from it, and the
-- reviews. Until now the app only knew the review LINK (marketing_tools.review_link); the
-- numbers lived in business.google.com and nobody looked at them in the same place as
-- ad spend and leads. Google's Performance API keeps 18 months and then forgets, so the
-- app stores what it fetches: the history becomes ours.
--
--   gbp_locations      — one row per listing the connected Google account manages.
--   gbp_reviews        — every review, with Google's reply state; replies go back via API.
--   gbp_metrics_daily  — one row per (location, day, metric) from the Performance API.
--   gbp_sync_runs      — every sync, with counts and the reason it failed, if it did.
--
-- Written ONLY by the server (service role) from the Google APIs. Authenticated users read;
-- there is no user-side write policy on purpose — the truth for these rows is Google, and a
-- hand-edited review count would be a lie the next sync silently corrects.

create table if not exists public.gbp_locations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  connected_user_id uuid not null references public.users(id) on delete cascade,   -- whose Google token syncs it (public.users, not auth.users: the prod migration role may not reference the auth schema; same id, and public.users cascades from auth.users)
  account_name      text not null,                       -- "accounts/123"
  location_name     text not null,                       -- "locations/456"
  title             text not null,
  primary_category  text,
  address           text,
  phone             text,
  website_uri       text,
  maps_uri          text,
  new_review_uri    text,
  place_id          text,
  average_rating    numeric(3,2),
  total_reviews     integer not null default 0,
  is_verified       boolean,
  last_synced_at    timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, location_name)
);

create table if not exists public.gbp_reviews (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  location_id        uuid not null references public.gbp_locations(id) on delete cascade,
  review_name        text not null,                      -- "accounts/../locations/../reviews/.."
  reviewer_name      text,
  reviewer_photo_uri text,
  is_anonymous       boolean not null default false,
  star_rating        smallint not null check (star_rating between 1 and 5),
  comment            text,
  reply_comment      text,
  replied_at         timestamptz,
  reviewed_at        timestamptz not null,
  updated_at_google  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, review_name)
);

create table if not exists public.gbp_metrics_daily (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  location_id uuid not null references public.gbp_locations(id) on delete cascade,
  day         date not null,
  metric      text not null,          -- BUSINESS_IMPRESSIONS_DESKTOP_MAPS, CALL_CLICKS, WEBSITE_CLICKS, …
  value       integer not null default 0 check (value >= 0),
  primary key (location_id, day, metric)
);

create table if not exists public.gbp_sync_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  trigger       text not null check (trigger in ('manual', 'cron', 'connect')),
  locations     integer not null default 0,
  reviews       integer not null default 0,
  metric_rows   integer not null default 0,
  ok            boolean,
  error         text
);

-- RLS: tenant reads; only the service role writes.
do $$
declare t text;
begin
  foreach t in array array['gbp_locations', 'gbp_reviews', 'gbp_metrics_daily', 'gbp_sync_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "tenant isolation read" on public.%I', t);
    execute format('create policy "tenant isolation read" on public.%I for select to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

create index if not exists gbp_reviews_location_time_idx on public.gbp_reviews (tenant_id, location_id, reviewed_at desc);
create index if not exists gbp_reviews_unanswered_idx on public.gbp_reviews (tenant_id, location_id) where reply_comment is null;
create index if not exists gbp_metrics_tenant_day_idx on public.gbp_metrics_daily (tenant_id, day);
create index if not exists gbp_sync_runs_tenant_idx on public.gbp_sync_runs (tenant_id, started_at desc);

comment on table public.gbp_locations is 'Google Business Profile listings synced from the connected Google account (server-written).';
comment on table public.gbp_reviews is 'Google reviews per listing; reply_comment mirrors the reply on Google.';
comment on table public.gbp_metrics_daily is 'Business Profile Performance API daily metrics, kept beyond Google''s 18-month window.';
