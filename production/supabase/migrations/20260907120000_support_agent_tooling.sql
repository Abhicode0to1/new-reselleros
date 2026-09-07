-- ============================================================================
-- Support agent tooling — brick 1 of the DSP merge (7 Sep 2026).
--
-- DSP (Delfos Support Panel, support.anutech.in) carries three pieces of agent
-- tooling that ResellerOS's /support has nothing for: internal notes (what the
-- agent knows but the customer must never see), time logs (minutes spent per
-- ticket, per agent), and canned responses (the snippets agents actually paste
-- all day). This migration gives them a tenant-scoped, RLS'd home so the
-- feature — and later DSP's 1,228 tickets of history — lives inside ResellerOS.
--
-- Design notes, so the choices don't look accidental:
--  · ticket linkage is a COMPOSITE FK (tenant_id, ticket_id) → support_tickets
--    (tenant_id, id) — same guard ai_support_conversations uses, so a row can
--    never point across tenants even if both halves exist. (support_tickets
--    already has the unique index from 20260824180000; the IF NOT EXISTS below
--    is belt-and-braces for a fresh database.)
--  · author_name is denormalised next to author_id, house style (customer_name
--    on support_tickets): the note must outlive the teammate who wrote it.
--  · notes and time logs are INSERT + SELECT only for authenticated — an audit
--    trail you can edit is not an audit trail. Mistake? Add a correcting note.
--  · Cloud SQL has no default privileges for our roles (01b deferred them), so
--    every grant here is explicit. service_role bypass = the same permissive
--    policy pattern 01b uses (BYPASSRLS does not exist on Cloud SQL).
-- ============================================================================

create unique index if not exists support_tickets_tenant_id_id_key
  on public.support_tickets (tenant_id, id);

-- ── Internal notes ──────────────────────────────────────────────────────────
create table if not exists public.support_ticket_notes (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  ticket_id   text        not null,
  author_id   uuid        references public.users(id) on delete set null,
  author_name text        not null,
  body        text        not null check (length(btrim(body)) between 1 and 8000),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, ticket_id)
    references public.support_tickets (tenant_id, id) on delete cascade
);

create index if not exists idx_support_ticket_notes_ticket
  on public.support_ticket_notes (tenant_id, ticket_id, created_at);

alter table public.support_ticket_notes enable row level security;

drop policy if exists support_ticket_notes_select on public.support_ticket_notes;
create policy support_ticket_notes_select on public.support_ticket_notes
  for select to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists support_ticket_notes_insert on public.support_ticket_notes;
create policy support_ticket_notes_insert on public.support_ticket_notes
  for insert to authenticated with check (tenant_id = public.current_tenant_id());

drop policy if exists zzz_service_role_all on public.support_ticket_notes;
create policy zzz_service_role_all on public.support_ticket_notes
  as permissive for all to service_role using (true) with check (true);

-- ── Time logs ───────────────────────────────────────────────────────────────
create table if not exists public.support_ticket_time_logs (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  ticket_id   text        not null,
  user_id     uuid        references public.users(id) on delete set null,
  user_name   text        not null,
  -- Whole minutes, hand-entered. 1..1440: nobody logs zero, nobody logs more
  -- than a day in one sitting — DSP's own data never exceeded a workday.
  minutes     int         not null check (minutes between 1 and 1440),
  note        text        check (note is null or length(note) <= 500),
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, ticket_id)
    references public.support_tickets (tenant_id, id) on delete cascade
);

create index if not exists idx_support_ticket_time_logs_ticket
  on public.support_ticket_time_logs (tenant_id, ticket_id, created_at);

alter table public.support_ticket_time_logs enable row level security;

drop policy if exists support_ticket_time_logs_select on public.support_ticket_time_logs;
create policy support_ticket_time_logs_select on public.support_ticket_time_logs
  for select to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists support_ticket_time_logs_insert on public.support_ticket_time_logs;
create policy support_ticket_time_logs_insert on public.support_ticket_time_logs
  for insert to authenticated with check (tenant_id = public.current_tenant_id());

drop policy if exists zzz_service_role_all on public.support_ticket_time_logs;
create policy zzz_service_role_all on public.support_ticket_time_logs
  as permissive for all to service_role using (true) with check (true);

-- ── Canned responses ────────────────────────────────────────────────────────
create table if not exists public.support_canned_responses (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  title       text        not null check (length(btrim(title)) between 1 and 120),
  body        text        not null check (length(btrim(body)) between 1 and 8000),
  usage_count int         not null default 0 check (usage_count >= 0),
  created_by  uuid        references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, title)
);

alter table public.support_canned_responses enable row level security;

drop policy if exists support_canned_responses_select on public.support_canned_responses;
create policy support_canned_responses_select on public.support_canned_responses
  for select to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists support_canned_responses_insert on public.support_canned_responses;
create policy support_canned_responses_insert on public.support_canned_responses
  for insert to authenticated with check (tenant_id = public.current_tenant_id());

drop policy if exists support_canned_responses_update on public.support_canned_responses;
create policy support_canned_responses_update on public.support_canned_responses
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists support_canned_responses_delete on public.support_canned_responses;
create policy support_canned_responses_delete on public.support_canned_responses
  for delete to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists zzz_service_role_all on public.support_canned_responses;
create policy zzz_service_role_all on public.support_canned_responses
  as permissive for all to service_role using (true) with check (true);

-- ── Grants — explicit, because Cloud SQL default privileges were deferred ──
grant select, insert                 on public.support_ticket_notes      to authenticated, service_role;
grant select, insert                 on public.support_ticket_time_logs  to authenticated, service_role;
grant select, insert, update, delete on public.support_canned_responses  to authenticated, service_role;
grant update, delete                 on public.support_ticket_notes      to service_role;
grant update, delete                 on public.support_ticket_time_logs  to service_role;
