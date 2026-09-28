-- ============================================================================
-- S34 — IndiaMART Lead Manager pull → leads. (Tally voucher export needs no schema.)
--
-- "IndiaMART/JustDial sirf label hain, koi API pull nahi" (roadmap, 27 Sep 2026). IndiaMART
-- gives each seller a CRM key for its Lead Manager "pull API"; a cron asks it for enquiries in
-- a time window and each becomes a lead with source 'indiamart'.
--
--   1. tenant_secrets.indiamart_crm_key — stored like every other integration credential,
--      sealed by lib/crypto (SECRET_COLUMNS). No key = the cron skips that company.
--   2. indiamart_lead_imports — one row per IndiaMART UNIQUE_QUERY_ID per company. This is the
--      dedupe: the pull windows overlap on purpose and IndiaMART re-sends, so the same
--      enquiry arrives more than once.
--   3. indiamart_sync_state — where the last pull ended, and IndiaMART's rate-limit back-off.
--   4. import_indiamart_lead() — claim the query id and create the lead in ONE transaction,
--      so two overlapping runs cannot both create it (CLAUDE.md §17b: multi-row writes go
--      through a function). Service role only.
-- ============================================================================

alter table public.tenant_secrets add column if not exists indiamart_crm_key text;
comment on column public.tenant_secrets.indiamart_crm_key is
  'S34: IndiaMART Lead Manager CRM key (glusr_crm_key). Sealed by lib/crypto/tenant-secrets.';

create table if not exists public.indiamart_lead_imports (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  query_id    text not null check (char_length(query_id) between 1 and 64),
  lead_id     text references public.leads(id) on delete set null,
  query_time  timestamptz,
  query_type  text,
  imported_at timestamptz not null default now(),
  primary key (tenant_id, query_id)
);
comment on table public.indiamart_lead_imports is
  'S34: IndiaMART UNIQUE_QUERY_IDs already turned into leads — the dedupe key for the pull cron.';

create table if not exists public.indiamart_sync_state (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  last_end_at     timestamptz,
  last_run_at     timestamptz,
  last_ok         boolean,
  last_error      text,
  last_imported   integer not null default 0,
  -- IndiaMART refuses a key that asks too often; honour its back-off instead of hammering.
  next_allowed_at timestamptz
);

alter table public.indiamart_lead_imports enable row level security;
alter table public.indiamart_sync_state   enable row level security;

revoke all on public.indiamart_lead_imports from anon, authenticated;
revoke all on public.indiamart_sync_state   from anon, authenticated;
grant select on public.indiamart_lead_imports, public.indiamart_sync_state to authenticated;
grant all on public.indiamart_lead_imports, public.indiamart_sync_state to service_role;

do $$
declare t text;
begin
  foreach t in array array['indiamart_lead_imports', 'indiamart_sync_state'] loop
    execute format('drop policy if exists "tenant isolation read" on public.%I', t);
    execute format('create policy "tenant isolation read" on public.%I for select to authenticated using (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

-- ── import_indiamart_lead ───────────────────────────────────────────────────
-- Returns the new lead id, or NULL when this query id was already imported.
create or replace function public.import_indiamart_lead(
  p_tenant_id    uuid,
  p_query_id     text,
  p_lead_id      text,
  p_company      text,
  p_contact_name text,
  p_email        text,
  p_phone        text,
  p_state        text,
  p_notes        text,
  p_query_time   timestamptz,
  p_query_type   text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed text;
begin
  if p_tenant_id is null or coalesce(trim(p_query_id), '') = '' or coalesce(trim(p_lead_id), '') = '' then
    raise exception 'import_indiamart_lead: tenant, IndiaMART query id and lead id are required — the cron builds these; check the parser output.';
  end if;

  insert into public.indiamart_lead_imports (tenant_id, query_id, query_time, query_type)
  values (p_tenant_id, trim(p_query_id), p_query_time, p_query_type)
  on conflict (tenant_id, query_id) do nothing
  returning query_id into v_claimed;

  if v_claimed is null then
    return null;  -- pehle hi aa chuka — duplicate, kuch mat banao
  end if;

  insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone,
                            source, stage, priority, state, notes)
  values (p_lead_id, p_tenant_id,
          coalesce(nullif(trim(p_company), ''), nullif(trim(p_contact_name), ''), nullif(trim(p_phone), ''), 'IndiaMART enquiry'),
          nullif(trim(p_contact_name), ''), nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
          'indiamart', 'new', 'medium', nullif(trim(p_state), ''), p_notes);

  update public.indiamart_lead_imports
     set lead_id = p_lead_id
   where tenant_id = p_tenant_id and query_id = v_claimed;

  return p_lead_id;
end $$;

revoke all on function public.import_indiamart_lead(uuid, text, text, text, text, text, text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.import_indiamart_lead(uuid, text, text, text, text, text, text, text, text, timestamptz, text)
  to service_role;
