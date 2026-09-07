-- ============================================================================
--  06 · Backup subsystem + merge-flow grant — the pieces the Cloud SQL restore missed
--  RUN AS postgres (switches to the right owners itself).
-- ----------------------------------------------------------------------------
--  Found by running the 50-test SQL suite against Cloud SQL (7 Sep 2026): 47 passed,
--  and all 3 failures traced here —
--   · schema `backup` (snapshots / restore points / pre-reset shield / offsite export)
--     was never carried over: the restore covered public+auth+storage only. The nightly
--     offsite-backup cron calls export_snapshots_for_offsite() and so fails on Cloud SQL.
--   · merge_stranded_user_into_tenant() reads auth.users, and its owner
--     (resellersos_migration) had no SELECT on that table.
--  Below: the auth grant, the schema (owned by resellersos_migration like every other
--  app object), then the six source migrations verbatim: 0210, 0211, 0212, 0241, 0244,
--  20260829040000.
-- ============================================================================
\set ON_ERROR_STOP on
GRANT supabase_auth_admin TO postgres;
SET ROLE supabase_auth_admin;
GRANT SELECT ON auth.users TO resellersos_migration;
RESET ROLE;
CREATE SCHEMA IF NOT EXISTS backup AUTHORIZATION resellersos_migration;
GRANT resellersos_migration TO postgres;
SET ROLE resellersos_migration;
SELECT current_user AS running_as;
\set ON_ERROR_STOP off

-- 0210 — a hidden `backup` schema for point-in-time full-data snapshots.
--
-- Lives OUTSIDE the API-exposed `public` schema, so PostgREST/RLS never surface
-- it to the app. Used to take a manual restore point before risky experiments
-- (the free Supabase plan has no automatic backups / PITR).
--
-- Taking a snapshot is a one-off manual operation (run in the SQL editor), not
-- part of this migration:
--   do $$
--   declare r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0;
--   begin
--     for r in select tablename from pg_tables
--       where schemaname='public' and tablename not in ('tenant_secrets','schema_migrations')
--       order by tablename
--     loop
--       execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', r.tablename) into tbl_json;
--       result := result || jsonb_build_object(r.tablename, tbl_json); n := n + 1;
--     end loop;
--     insert into backup.snapshots(label, table_count, payload) values ('manual snapshot', n, result);
--   end $$;

create schema if not exists backup;

create table if not exists backup.snapshots (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  label       text,
  table_count int,
  payload     jsonb not null
);
-- 0211 — in-app "Backup" feature (owner-only, tenant-scoped).
--
-- Each reseller can take a snapshot of THEIR OWN data and download it. Snapshots
-- live in the hidden `backup` schema (not API-exposed); all access is via these
-- SECURITY DEFINER functions, which scope strictly to the caller's tenant. This
-- must never dump another tenant's rows.

alter table backup.snapshots add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
create index if not exists idx_backup_snapshots_tenant on backup.snapshots(tenant_id, created_at desc);

-- Take a full snapshot of the caller's tenant data → store + return metadata.
create or replace function public.create_tenant_backup(p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_role text; r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0; v_id uuid;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can take a backup'; end if;

  -- The tenant's own row.
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into tbl_json from public.tenants t where t.id = v_tenant;
  result := jsonb_build_object('tenants', tbl_json); n := 1;

  -- Every public table that has a tenant_id column, filtered to this tenant.
  -- Secrets are never backed up.
  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname = 'public' and pt.tablename = c.table_name
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
      and c.table_name not in ('tenant_secrets')
    order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.tenant_id = $1', r.table_name)
      into tbl_json using v_tenant;
    result := result || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;

  insert into backup.snapshots(tenant_id, label, table_count, payload)
  values (v_tenant, coalesce(nullif(btrim(p_label), ''), 'Manual backup'), n, result)
  returning id into v_id;

  -- Keep the latest 20 per tenant so the table doesn't grow forever.
  delete from backup.snapshots s
  where s.tenant_id = v_tenant
    and s.id not in (
      select id from backup.snapshots where tenant_id = v_tenant order by created_at desc limit 20
    );

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $$;

-- List the caller's snapshots (metadata only).
create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamptz, label text, table_count int, bytes int)
language sql security definer set search_path = public as $$
  select s.id, s.created_at, s.label, s.table_count, length(s.payload::text)
  from backup.snapshots s
  where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
  order by s.created_at desc;
$$;

-- Fetch one snapshot's full payload (for download) — only if it's the caller's.
create or replace function public.get_tenant_backup(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select payload from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$$;

-- Delete one of the caller's snapshots.
create or replace function public.delete_tenant_backup(p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$$;

grant execute on function public.create_tenant_backup(text) to authenticated;
grant execute on function public.list_tenant_backups() to authenticated;
grant execute on function public.get_tenant_backup(uuid) to authenticated;
grant execute on function public.delete_tenant_backup(uuid) to authenticated;
-- 0212 — restore points: auto snapshots + one-click restore (owner, tenant-scoped).
--
-- Builds on 0210/0211. Adds:
--   * backup.snapshots.kind ('manual' | 'auto')
--   * backup._take(tenant, label, kind)  — shared snapshot builder, keeps last 15
--   * public.auto_backup_if_stale()      — makes a daily 'auto' restore point
--   * public.restore_tenant_backup(id)   — ATOMIC restore of the caller's data to
--     a chosen point; first saves a 'Before restore' safety point, then replaces
--     all tenant-scoped tables from the snapshot. FK order + triggers are bypassed
--     with session_replication_role=replica; the whole thing is one transaction, so
--     a failure rolls everything back and nothing is lost. Never touches users,
--     tenant_secrets, or the tenants row.

alter table backup.snapshots add column if not exists kind text not null default 'manual';

-- ── Shared snapshot builder (internal; not exposed to the API) ────────────────
create or replace function backup._take(p_tenant uuid, p_label text, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0; v_id uuid;
begin
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into tbl_json from public.tenants t where t.id = p_tenant;
  result := jsonb_build_object('tenants', tbl_json); n := 1;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id'
      and c.table_name not in ('tenant_secrets')
    group by c.table_name order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.tenant_id = $1', r.table_name)
      into tbl_json using p_tenant;
    result := result || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;

  insert into backup.snapshots(tenant_id, label, kind, table_count, payload)
  values (p_tenant, coalesce(nullif(btrim(p_label), ''), 'Backup'), p_kind, n, result)
  returning id into v_id;

  -- Keep the newest 15 restore points per tenant (always ≥10 available).
  delete from backup.snapshots s
  where s.tenant_id = p_tenant
    and s.id not in (select id from backup.snapshots where tenant_id = p_tenant order by created_at desc limit 15);

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $$;

-- ── Manual backup (owner) ─────────────────────────────────────────────────────
create or replace function public.create_tenant_backup(p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role text;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can take a backup'; end if;
  return backup._take(v_tenant, coalesce(p_label, 'Manual backup'), 'manual');
end $$;

-- ── Auto daily restore point (owner) — no-op if a snapshot < 20h old exists ───
create or replace function public.auto_backup_if_stale()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_role text; v_last timestamptz;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null or coalesce(v_role,'') <> 'owner' then return jsonb_build_object('created', false); end if;
  select max(created_at) into v_last from backup.snapshots where tenant_id = v_tenant;
  if v_last is not null and v_last > now() - interval '20 hours' then
    return jsonb_build_object('created', false);
  end if;
  perform backup._take(v_tenant, 'Auto (daily)', 'auto');
  return jsonb_build_object('created', true);
end $$;

-- ── Restore to a chosen point (owner) — ATOMIC + reversible ───────────────────
create or replace function public.restore_tenant_backup(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_role text; v_payload jsonb; r record; col_list text; has_identity bool; n int := 0;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can restore'; end if;

  select payload into v_payload from backup.snapshots where id = p_id and tenant_id = v_tenant;
  if v_payload is null then raise exception 'Restore point not found'; end if;

  -- Safety point of the CURRENT state first, so the restore itself is undoable.
  perform backup._take(v_tenant, 'Before restore ' || to_char(now(), 'DD Mon HH24:MI'), 'auto');

  -- Bypass FK ordering + data triggers for the bulk replace. Whole function is one
  -- transaction: any error rolls the entire restore back (no partial data loss).
  set local session_replication_role = replica;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id'
      and c.table_name not in ('tenant_secrets','users')
    group by c.table_name order by c.table_name
  loop
    if not (v_payload ? r.table_name) then continue; end if;

    -- Insertable columns = everything except GENERATED ALWAYS (computed) columns.
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position), bool_or(is_identity = 'YES')
      into col_list, has_identity
    from information_schema.columns
    where table_schema='public' and table_name = r.table_name and is_generated <> 'ALWAYS';

    execute format('delete from public.%I where tenant_id = $1', r.table_name) using v_tenant;
    execute format(
      'insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1)',
      r.table_name, col_list,
      case when has_identity then 'overriding system value' else '' end,
      col_list, r.table_name
    ) using (v_payload -> r.table_name);
    n := n + 1;
  end loop;

  set local session_replication_role = origin;
  return jsonb_build_object('restored_tables', n, 'restored_at', now());
end $$;

-- List now includes kind.
create or replace function public.list_tenant_backups()
returns table(id uuid, created_at timestamptz, label text, kind text, table_count int, bytes int)
language sql security definer set search_path = public as $$
  select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
  from backup.snapshots s
  where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
  order by s.created_at desc;
$$;

grant execute on function public.create_tenant_backup(text) to authenticated;
grant execute on function public.auto_backup_if_stale() to authenticated;
grant execute on function public.restore_tenant_backup(uuid) to authenticated;
grant execute on function public.list_tenant_backups() to authenticated;
-- 0241 — selective table reset, and the backup that must succeed before it runs
--
-- WHY A FUNCTION AND NOT AN API ROUTE THAT DELETES
-- ------------------------------------------------
-- The reset and the backup that protects it have to be ONE transaction. If they
-- are two steps in TypeScript, every failure between them leaves the tenant with
-- rows deleted and no snapshot — the exact state this exists to prevent. In here
-- a failed delete rolls the backup back too, which is harmless: nothing was
-- deleted either. The only outcomes are "backup AND reset" or "neither".
--
-- THE ALLOWLIST IS THE SECURITY BOUNDARY
-- --------------------------------------
-- p_tables arrives from a browser. %I quoting stops injection, but it does not
-- stop 'users' or 'payments' being passed by a bug or by someone with the
-- owner's session. Anything not on RESETTABLE below is refused by name, so the
-- worst a compromised caller can do is clear tables the UI already offers.
--
-- STATUTORY TABLES ARE NOT ORDINARY DATA
-- --------------------------------------
-- invoices and attendance are on the list because they were asked for, but they
-- are records the business is required to keep — GST tax invoices must form an
-- unbroken series (CLAUDE.md §17a, CGST §31), and attendance backs payroll. They
-- need p_confirm_statutory => true, passed deliberately, so "reset my demo data"
-- can never quietly also mean "delete this year's invoices".
--
-- ⚠️  RUN THE DDL ALONE, verify in a SEPARATE run (§25.6).

begin;

-- Tables the UI may offer, mapped to the checkbox the owner ticks. Anything
-- absent here cannot be reset by this function at all.
create or replace function backup._resettable()
returns table (key text, tbl text, statutory boolean)
language sql immutable as $$
  values
    ('leads',      'leads',            false),
    ('leads',      'lead_activities',  false),
    -- quotes store their line items inline; there is no quote_items table.
    ('quotes',     'quotes',           false),
    ('tasks',      'tasks',            false),
    ('expenses',   'expense_claims',   false),
    -- Statutory — see the header. Never reachable without p_confirm_statutory.
    ('invoices',   'invoices',         true),
    ('attendance', 'attendance',       true)
$$;

comment on function backup._resettable() is
  'Allowlist for reset_tenant_selected_tables. A table not listed here cannot be reset, whatever the caller sends.';

create or replace function public.reset_tenant_selected_tables(
  p_tables             text[],
  p_label              text,
  p_confirm_statutory  boolean default false
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid;
  v_role     text;
  v_backup   jsonb;
  v_bad      text[];
  v_stat     text[];
  r          record;
  v_deleted  jsonb := '{}'::jsonb;
  n          bigint;
begin
  -- ── Who ────────────────────────────────────────────────────────────────
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then
    raise exception 'No tenant for caller';
  end if;
  if coalesce(v_role, '') <> 'owner' then
    raise exception 'Only the owner can reset data. Ask the account owner to do this.';
  end if;

  if p_tables is null or cardinality(p_tables) = 0 then
    raise exception 'Nothing selected. Tick at least one section to reset.';
  end if;

  -- ── Refuse anything off the allowlist, BY NAME ─────────────────────────
  select array_agg(t) into v_bad
  from unnest(p_tables) t
  where t not in (select key from backup._resettable());

  if v_bad is not null then
    raise exception 'Not resettable: %. Allowed: %',
      array_to_string(v_bad, ', '),
      (select string_agg(distinct key, ', ' order by key) from backup._resettable());
  end if;

  -- ── Statutory sections need saying so out loud ─────────────────────────
  select array_agg(distinct key) into v_stat
  from backup._resettable()
  where statutory and key = any(p_tables);

  if v_stat is not null and not p_confirm_statutory then
    raise exception
      'Refusing to reset % — these are statutory records (GST invoice series must have no gaps; attendance backs payroll). Re-run with the statutory confirmation if you are certain.',
      array_to_string(v_stat, ', ');
  end if;

  -- ── THE SHIELD. Before a single row is deleted. ────────────────────────
  -- backup._take raises on failure, so reaching the next line means a snapshot
  -- exists. The size check catches the quieter failure: a snapshot row that
  -- was written but holds nothing.
  v_backup := backup._take(v_tenant, 'Pre-Reset Safeguard Snapshot - ' || coalesce(p_label, 'unlabelled'), 'pre_reset');

  if v_backup is null
     or coalesce((v_backup->>'bytes')::bigint, 0) = 0
     or coalesce((v_backup->>'table_count')::int, 0) = 0 then
    raise exception 'Pre-reset backup produced an empty snapshot — refusing to delete anything. Nothing has been changed.';
  end if;

  -- ── Delete, tenant-scoped, allowlisted tables only ─────────────────────
  for r in
    select tbl from backup._resettable() where key = any(p_tables)
  loop
    -- Verified here rather than trusted from the list above. A table that was
    -- renamed, dropped, or never had tenant_id would otherwise fail mid-loop
    -- with a cryptic error, and the allowlist is maintained by hand — the one
    -- place a stale entry turns a safety feature into the thing that breaks.
    -- An unscoped table is the dangerous case: `delete from x` with no
    -- tenant_id would take EVERY tenant's rows, so it must abort, not proceed.
    if to_regclass('public.' || quote_ident(r.tbl)) is null then
      raise exception 'Reset allowlist is stale: table public.% does not exist. Nothing has been changed.', r.tbl;
    end if;
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = 'tenant_id'
    ) then
      raise exception 'Refusing to reset public.% — it has no tenant_id, so the delete could not be scoped to one tenant. Nothing has been changed.', r.tbl;
    end if;

    execute format('delete from public.%I where tenant_id = $1', r.tbl) using v_tenant;
    get diagnostics n = row_count;
    v_deleted := v_deleted || jsonb_build_object(r.tbl, n);
  end loop;

  return jsonb_build_object(
    'backup_id',  v_backup->>'id',
    'backup_bytes', (v_backup->>'bytes')::bigint,
    'deleted',    v_deleted,
    'label',      p_label
  );
end $$;

comment on function public.reset_tenant_selected_tables(text[], text, boolean) is
  'Owner-only selective reset. Takes a pre_reset snapshot FIRST and aborts if it is empty; backup and deletes share one transaction, so the only outcomes are both or neither.';

revoke all on function public.reset_tenant_selected_tables(text[], text, boolean) from public;
grant execute on function public.reset_tenant_selected_tables(text[], text, boolean) to authenticated;

commit;

-- ── VERIFY — SEPARATE run ───────────────────────────────────────────────────
--
-- select key, tbl, statutory from backup._resettable() order by key, tbl;
--
-- Refusal paths (each should RAISE, and change nothing):
--   select public.reset_tenant_selected_tables(array['users'],    'probe');           -- not resettable
--   select public.reset_tenant_selected_tables(array['invoices'], 'probe');           -- statutory, unconfirmed
--   select public.reset_tenant_selected_tables(array[]::text[],   'probe');           -- nothing selected
-- ============================================================================
-- 0244 — nightly backups for EVERY tenant, and one retention number
-- ============================================================================
--
-- ─── WHAT WAS ACTUALLY MISSING ──────────────────────────────────────────────
-- The backup feature was almost complete and had one hole in the middle: nothing
-- ran on a schedule. `auto_backup_if_stale()` (0212) fires only when a human
-- opens Settings → Backup, so a tenant whose owner does not visit that page has
-- no automatic protection at all — which is precisely the tenant that will need
-- it. The page meanwhile promises restore points are made "apne aap roz".
--
-- ─── WHY A NEW FUNCTION AND NOT "JUST CALL create_tenant_backup" ────────────
-- Every existing entry point derives the tenant from `auth.uid()`. A cron has no
-- auth.uid(), so it cannot use any of them. `backup_all_tenants()` takes the
-- tenant from the loop instead of from a session, which is exactly why it must
-- NOT be reachable by `authenticated`: it is the one function here that can touch
-- rows outside the caller's tenant. EXECUTE is granted to service_role only, so
-- it is reachable from a server route holding the service key and from nowhere
-- else — a signed-in user cannot call it even with a crafted request.
--
-- ─── RETENTION: ONE NUMBER, BECAUSE THERE WERE THREE ────────────────────────
-- Before this migration the same fact was stated three ways:
--     0211's create_tenant_backup   kept 20   (dead code — 0212 replaced it)
--     0212's backup._take           kept 15   (the live behaviour)
--     the UI                        said both "last 15" and "last 20"
-- The live answer was 15. It is now 30 in the only place that decides, and the
-- UI reads a single exported constant (SNAPSHOT_RETENTION) instead of restating
-- it. 30 is affordable: measured on this database a snapshot is ~83 kB, so a
-- full shelf is about 2.5 MB per tenant.
--
-- ⚠️ Scheduling is NOT vercel.json. The live deployment is Cloud Run, where
-- Vercel crons do not exist and that file is inert (see the header of
-- api/cron/renewals). The job belongs in scripts/setup-cloud-scheduler.sh.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ──────────────────────────────────────────
-- One batch at a time; the verify block is a SEPARATE run.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 1 · Retention 15 → 30, in the one function that enforces it
-- ───────────────────────────────────────────────────────────────────────────
begin;

create or replace function backup._take(p_tenant uuid, p_label text, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; result jsonb := '{}'::jsonb; tbl_json jsonb; n int := 0; v_id uuid;
begin
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into tbl_json from public.tenants t where t.id = p_tenant;
  result := jsonb_build_object('tenants', tbl_json); n := 1;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id'
      and c.table_name not in ('tenant_secrets')
    group by c.table_name order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.tenant_id = $1', r.table_name)
      into tbl_json using p_tenant;
    result := result || jsonb_build_object(r.table_name, tbl_json);
    n := n + 1;
  end loop;

  insert into backup.snapshots(tenant_id, label, kind, table_count, payload)
  values (p_tenant, coalesce(nullif(btrim(p_label), ''), 'Backup'), p_kind, n, result)
  returning id into v_id;

  -- Keep the newest 30 restore points per tenant. Mirrored in TypeScript as
  -- SNAPSHOT_RETENTION (lib/queries/backups.ts) — change both together.
  delete from backup.snapshots s
  where s.tenant_id = p_tenant
    and s.id not in (select id from backup.snapshots where tenant_id = p_tenant order by created_at desc limit 30);

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $$;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 2 · The nightly sweep
-- ───────────────────────────────────────────────────────────────────────────
begin;

create or replace function public.backup_all_tenants(p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t          record;
  v_snap     jsonb;
  v_label    text := coalesce(nullif(btrim(p_label), ''),
                              'Automated Daily Backup - ' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'));
  v_ok       int := 0;
  v_failed   int := 0;
  v_bytes    bigint := 0;
  v_results  jsonb := '[]'::jsonb;
begin
  for t in select id, name from public.tenants order by created_at loop
    /* Per-tenant exception handling on purpose: one tenant with a corrupt row
       must not cost every OTHER tenant its nightly backup. A sweep that aborts
       halfway is worse than one that reports a partial failure, because the
       tenants it never reached look protected and are not. */
    begin
      v_snap  := backup._take(t.id, v_label, 'auto');
      v_ok    := v_ok + 1;
      v_bytes := v_bytes + coalesce((v_snap->>'bytes')::bigint, 0);
      v_results := v_results || jsonb_build_object(
        'tenant', t.name, 'ok', true,
        'bytes', (v_snap->>'bytes')::bigint,
        'tables', (v_snap->>'table_count')::int);
    exception when others then
      v_failed  := v_failed + 1;
      v_results := v_results || jsonb_build_object('tenant', t.name, 'ok', false, 'error', sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'label', v_label, 'ok', v_ok, 'failed', v_failed,
    'total_bytes', v_bytes, 'results', v_results);
end $$;

comment on function public.backup_all_tenants(text) is
  'Nightly sweep: one snapshot per tenant. service_role ONLY — it is the single backup function that is not scoped to the caller''s own tenant. A per-tenant failure is recorded and the sweep continues.';

-- The grant IS the security boundary here.
revoke all on function public.backup_all_tenants(text) from public, anon, authenticated;
grant execute on function public.backup_all_tenants(text) to service_role;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- Expect: retention_30 = true
--         authenticated/anon/PUBLIC may NOT execute backup_all_tenants
-- (Read the ACL from pg_proc, not information_schema — that view filters rows to
--  roles the current role belongs to and will happily report "0 grants" for a
--  function that is in fact granted. Learned on 0243.)
-- ============================================================================
/*
select 'retention_30' as check,
       (pg_get_functiondef(p.oid) like '%limit 30%')::text as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'backup' and p.proname = '_take'
union all
select 'backup_all_tenants acl',
       coalesce(array_to_string(p.proacl, ' | '), '(default: PUBLIC EXECUTE)')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'backup_all_tenants';
*/
-- Off-site backup export: ek service-role-only raasta, taaki raat wala backup database ke
-- BAHAR bhi ja sake.
--
-- ─── YE KYUN CHAHIYE ────────────────────────────────────────────────────────
-- Roz 00:00 IST par `backup_all_tenants()` har tenant ka snapshot leta hai, aur wo chal bhi
-- raha hai — 29 Aug 2026 ko teeno tenant ke aaj ke snapshot maujood mile. Par wo sab
-- `backup.snapshots` me hain, yaani **usi database ke andar jiska wo backup hain**. Project
-- gaya to backup bhi usi ke saath jayega, aur is plan par Supabase ka apna koi backup nahi hai.
--
-- Database ke bahar ki ekmatra copy Pardeep ke laptop par thi, haath se banti thi, aur 29 Aug
-- ko teen din purani nikli. 26 Aug ko reset chal chuka hai, yaani ab jo data banega wo ASLI
-- hoga — abhi tak jo kho sakta tha wo nakli tha.
--
-- ─── MAUJOODA RPC KYUN KAAFI NAHI THI ───────────────────────────────────────
-- `get_tenant_backup(p_id)` payload deti hai, par `tenant_id = (select tenant_id from users
-- where id = auth.uid())` par bandhi hai. Cron service_role se chalta hai aur uska koi
-- `auth.uid()` nahi hota, to wahan se hamesha khaali aata hai. Wo shart sahi hai aur usme
-- haath nahi lagaya gaya — wahi cheez browser se aane wale har request ko rokti hai.
--
-- ─── SURAKSHA: GRANT SE, STRING PADH KAR NAHI ───────────────────────────────
-- Ye function HAR tenant ka poora data ek saath lautata hai. Isliye pahunch `revoke`/`grant`
-- se tay hoti hai — PostgREST role khud lagu karta hai, aur us par bharosa mere likhe hue
-- `current_setting('request.jwt.claims')` wale check se kahin zyada hai. Supabase har naye
-- function par `execute` PUBLIC ko deta hai, isliye neeche revoke karna choice nahi, zaroori
-- hai.
--
-- Body me ek doosra pehra bhi hai. Do pehre isliye ki agar kabhi koi migration galti se
-- `grant execute ... to authenticated` kar de, to wo galti chup-chaap cross-tenant leak na
-- ban jaye. Is repo me sabse mehngi galti wahi kism hai.

create or replace function public.export_snapshots_for_offsite(p_since timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  /* `nullif(…, '')` choice nahi hai. `set_config('request.jwt.claims', null, true)` setting ko
     KHAALI STRING banata hai, NULL nahi — aur `''::jsonb` 22P02 se marta hai. Bina iske ye
     function har us session me crash karta hai jisne claims saaf ki hon, aur wo crash "backup
     nahi hua" jaisa hi dikhta. Pehli baar test chalate hi yahi hua. */
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_out  jsonb;
begin
  /* Doosra pehra. Asli deewar neeche wala grant hai; ye us din ke liye hai jis din koi
     grant galti se khul jaye. `auth.uid()` ka hona hi kaafi saboot hai ki ye ek browser
     session hai, aur ye function browser se kabhi nahi chalna chahiye. */
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'export_snapshots_for_offsite is service_role only';
  end if;

  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) into v_out
  from (
    /* Har tenant ka sirf SABSE NAYA snapshot. Poora itihaas bhejna har raat pichhli
       raaton ki nakal dobara upload karta, aur off-site copy ka size roz badhta jaata
       bina kisi naye saboot ke. */
    select distinct on (s.tenant_id)
      jsonb_build_object(
        'tenant_id',   s.tenant_id,
        'tenant_name', t.name,
        'snapshot_id', s.id,
        'created_at',  s.created_at,
        'label',       s.label,
        'kind',        s.kind,
        'table_count', s.table_count,
        'payload',     s.payload
      ) as x
    from backup.snapshots s
    join public.tenants t on t.id = s.tenant_id
    where s.created_at >= p_since
    order by s.tenant_id, s.created_at desc
  ) q;

  return v_out;
end;
$$;

comment on function public.export_snapshots_for_offsite(timestamptz) is
  'service_role only. Har tenant ka sabse naya snapshot (p_since ke baad ka), taaki nightly '
  'cron use database ke bahar Cloud Storage par rakh sake. Browser se kabhi nahi.';

revoke all on function public.export_snapshots_for_offsite(timestamptz) from public;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from anon;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from authenticated;
grant execute on function public.export_snapshots_for_offsite(timestamptz) to service_role;
RESET ROLE;
