-- AI Lead Finder (27 Sep 2026).
--
-- An agent that looks for companies matching the owner's ideal customer profile, checks
-- each one with public, legitimate signals, scores it, and hands it over for approval —
-- nothing lands in `leads` until a person says yes.
--
-- Signals, and why they are the ones used:
--   MX record  — which mail provider a domain uses. Not on Google Workspace (Zoho, Rediff,
--                GoDaddy, cPanel, nothing) = a Workspace prospect. DNS is public by design.
--   Website    — no site / no HTTPS / dead host / very old stack = website & hosting prospect.
--   Discovery  — Gemini with Google Search grounding, answering "which companies fit this
--                profile", from public web pages. No Maps / Business Profile scraping: that
--                breaks Google's terms and would put the OAuth client (Contacts, Gmail, GBP,
--                Ads) at risk for the sake of a list.
--
--   lead_finder_profiles   — the ICP: city, industry, size, products to pitch, daily cap.
--   lead_finder_runs       — every run, counts, and why it stopped.
--   lead_finder_candidates — one row per company found; status new → approved / rejected;
--                            approved creates the lead (source 'ai-finder') and records its id.
-- Profiles are the owner's to edit; candidates are server-written and the owner changes
-- only status / lead_id (approve / reject) — the update policy is broad, the page is narrow.

create table if not exists public.lead_finder_profiles (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  name           text not null check (char_length(trim(name)) between 2 and 80),
  cities         text not null default '',        -- "Gurgaon, Delhi NCR"
  industries     text not null default '',        -- "IT services, CA firms, real estate"
  company_size   text not null default '10-200 employees',
  products       text[] not null default '{workspace,website,hosting}',   -- what to pitch
  must_have      text not null default '',        -- free text: "own domain email", "hiring"
  exclude        text not null default '',        -- "MNCs, government, our competitors"
  daily_limit    integer not null default 20 check (daily_limit between 1 and 200),
  enabled        boolean not null default true,
  last_run_at    timestamptz,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.lead_finder_runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  profile_id   uuid references public.lead_finder_profiles(id) on delete set null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  trigger      text not null check (trigger in ('manual', 'cron')),
  discovered   integer not null default 0,
  skipped_dupe integer not null default 0,
  saved        integer not null default 0,
  ok           boolean,
  error        text
);

create table if not exists public.lead_finder_candidates (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  profile_id     uuid references public.lead_finder_profiles(id) on delete set null,
  run_id         uuid references public.lead_finder_runs(id) on delete set null,
  company        text not null,
  domain         text not null,
  website        text,
  city           text,
  description    text,
  source_url     text,
  mx_provider    text,                             -- google | microsoft | zoho | rediff | godaddy | cpanel | other | none | unknown
  on_workspace   boolean,
  site_https     boolean,
  site_status    integer,
  site_note      text,
  signals        jsonb not null default '{}'::jsonb,
  score          integer check (score between 0 and 100),
  product        text,                             -- best product to pitch
  fit_reason     text,
  pitch          text,
  status         text not null default 'new' check (status in ('new', 'approved', 'rejected', 'converted')),
  lead_id        text references public.leads(id) on delete set null,   -- leads.id is text (L-…)
  decided_by     uuid,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  unique (tenant_id, domain)
);

do $$
declare t text;
begin
  foreach t in array array['lead_finder_profiles', 'lead_finder_runs', 'lead_finder_candidates'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "tenant isolation read" on public.%I', t);
    execute format('create policy "tenant isolation read" on public.%I for select to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

-- Profiles: the owner's own rows.
drop policy if exists "tenant isolation write" on public.lead_finder_profiles;
create policy "tenant isolation write" on public.lead_finder_profiles for insert to authenticated with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation update" on public.lead_finder_profiles;
create policy "tenant isolation update" on public.lead_finder_profiles for update to authenticated using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
drop policy if exists "tenant isolation delete" on public.lead_finder_profiles;
create policy "tenant isolation delete" on public.lead_finder_profiles for delete to authenticated using (tenant_id = public.current_tenant_id());
-- Candidates: approve / reject only (the page never edits anything else).
drop policy if exists "tenant isolation update" on public.lead_finder_candidates;
create policy "tenant isolation update" on public.lead_finder_candidates for update to authenticated using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());

create index if not exists lead_finder_candidates_status_idx on public.lead_finder_candidates (tenant_id, status, score desc);
create index if not exists lead_finder_runs_tenant_idx on public.lead_finder_runs (tenant_id, started_at desc);

comment on table public.lead_finder_candidates is 'AI Lead Finder output — companies found + public signals; approved rows become leads (source ai-finder).';
