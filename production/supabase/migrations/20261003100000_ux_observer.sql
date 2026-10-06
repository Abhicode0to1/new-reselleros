-- ============================================================================
-- UX observer — friction signals from real use, and the AI's reading of them (3 Oct 2026).
--
-- Pardeep: "ek ai agent aisa banana hai — jab user ya visitor app/website par kaam karta hai
-- to AI behaviour, user-friendly aur logical point se kya kamiyan hain aur kya improvement
-- hone chahiye; jab koi active ho tabhi ye chalu ho".
--
-- ux_events: what the browser saw while someone was ACTIVE (tab visible, input in the last
-- minute) — rage clicks, clicks on things that do nothing, errors shown, forms started and
-- left, long stalls, quick exits. Never what anyone typed: no input values, emails or
-- digits in labels are masked in the browser AND again on the server
-- (lib/ux/signals.ts). Visitors are an anonymous per-tab id; no cookie, no IP stored.
--
-- ux_insights: what the analysis concluded per page — problem, evidence, fix — with a
-- status: new → queued ("Make card") → carded (board card) → done, or dismissed. Pardeep
-- chose this path to a fix: card → AI fixes → he checks → the observer confirms it stayed fixed.
--
-- Written and read only by server routes (service role); the routes check the caller is
-- an owner/manager of the tenant before reading. Kept 30 days (purge function below).
-- ============================================================================
begin;

create table if not exists public.ux_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants(id) on delete cascade,  -- null = public website visitor
  user_id     uuid,                                                  -- signed-in user, else null
  session_id  text not null check (char_length(session_id) between 8 and 64),
  surface     text not null check (surface in ('app', 'site')),
  path        text not null check (char_length(path) <= 200),
  kind        text not null check (kind in ('view', 'rage_click', 'dead_click', 'error', 'form_abandon', 'stall', 'quick_exit', 'slow')),
  target      text check (target is null or char_length(target) <= 160),
  detail      text check (detail is null or char_length(detail) <= 300),
  ms          integer check (ms is null or ms >= 0),
  created_at  timestamptz not null default now()
);
create index if not exists ux_events_recent_idx on public.ux_events (surface, created_at desc);
create index if not exists ux_events_tenant_idx on public.ux_events (tenant_id, created_at desc);

create table if not exists public.ux_insights (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,  -- null = public website
  surface     text not null check (surface in ('app', 'site')),
  path        text not null,
  severity    text not null check (severity in ('high', 'medium', 'low')),
  category    text not null check (category in ('confusing', 'broken', 'slow', 'copy', 'logic', 'flow')),
  problem     text not null check (char_length(problem) <= 300),
  evidence    text not null check (char_length(evidence) <= 400),
  fix         text not null check (char_length(fix) <= 500),
  signature   text not null,                                         -- dedupe key: surface|path|category|signal
  -- new → queued (owner pressed "Make card") → carded (card on the board) → done; or dismissed.
  -- A done insight whose signal comes back AFTER done_at is reopened by the analysis.
  status      text not null default 'new' check (status in ('new', 'queued', 'carded', 'done', 'dismissed')),
  card_ref    text check (card_ref is null or char_length(card_ref) <= 60),
  done_at     timestamptz,
  sessions    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists ux_insights_sig_idx on public.ux_insights (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), signature);

create table if not exists public.ux_analysis_runs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants(id) on delete cascade,
  ran_at      timestamptz not null default now(),
  events_seen integer not null default 0,
  insights    integer not null default 0,
  mode        text not null
);

do $$
declare t text;
begin
  foreach t in array array['ux_events', 'ux_insights', 'ux_analysis_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update, delete on public.ux_events, public.ux_insights, public.ux_analysis_runs to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.purge_ux_events() returns integer
language sql security definer set search_path = public as $$
  with d as (delete from public.ux_events where created_at < now() - interval '30 days' returning 1)
  select count(*)::integer from d;
$$;
revoke all on function public.purge_ux_events() from public, anon, authenticated;
grant execute on function public.purge_ux_events() to service_role;

comment on table public.ux_events is 'Friction signals seen while a person was active (no typed values; PII masked). 30-day retention.';
create index if not exists ux_runs_tenant_idx on public.ux_analysis_runs (tenant_id, ran_at desc);

comment on table public.ux_insights is 'UX problems per page found by the observer analysis, with evidence and the suggested fix.';

commit;
