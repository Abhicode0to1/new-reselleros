-- Capture the `backup` schema, which every captured migration USES and none CREATES.
--
-- ─── THE DRIFT, MEASURED 11 SEP 2026 ────────────────────────────────────────
-- Seven functions in `public` read or write `backup.snapshots`:
--
--   create_tenant_backup   list_tenant_backups   get_tenant_backup
--   delete_tenant_backup   backup_all_tenants    auto_backup_if_stale
--   export_snapshots_for_offsite
--
-- All seven are present in a freshly reset local database, because `baseline.sql`
-- carries them. The schema they depend on is not:
--
--   schema_backup_exists = false
--   public_fns           = all seven present
--
-- So on a fresh database all seven are broken, and the two SQL regression tests
-- that exercise them fail with `schema "backup" does not exist` and
-- `relation "backup.snapshots" does not exist`. Production is fine — it has the
-- schema, and the nightly sweep has been running — which is exactly why nobody
-- noticed. The baseline was dumped `public`-only, and the DDL was left behind in
-- `migrations-archive/0210` + `0211` when the timestamped series began.
--
-- This is the failure mode CLAUDE.md §17 is about, seen from the other side: not
-- a change applied to prod without a migration, but a change that exists in prod
-- and in the archive while the *replayable* history cannot rebuild it.
--
-- ─── PROVENANCE: NOTHING HERE IS INVENTED ───────────────────────────────────
-- The two function bodies are copied verbatim from
-- `supabase/cloudsql/07-sync-backup-functions-from-live.sql`, which was itself
-- produced by `pg_get_functiondef` against the LIVE source database — see that
-- file's header. The table's final shape is the archive's `0210` create plus the
-- two later `alter … add column` statements (`tenant_id` in `0211`, `kind` in
-- `cloudsql/06`), folded into one create here.
--
-- That mattered enough to check rather than reconstruct. `backup._take` is the
-- snapshot the pre-reset shield takes before a tenant's data is deleted, and
-- `backup._resettable()` is the list of tables a reset is ALLOWED to touch. A
-- plausible-looking guess at either would be a guess at the safety net that
-- stands between a reset and somebody's invoices.
--
-- ─── SAFE TO RUN ON PRODUCTION, WHERE ALL OF THIS ALREADY EXISTS ────────────
-- Every statement is `if not exists` or `create or replace`, so on prod this is a
-- no-op that records the truth in the history. The `create table` cannot damage
-- the existing table (it is skipped whole), and the two function bodies are
-- byte-identical to what is already installed there.
--
-- ─── NO GRANTS, DELIBERATELY ────────────────────────────────────────────────
-- `backup` is not in PostgREST's exposed schemas and no role is given `usage` on
-- it. That absence IS the security property: snapshots hold every row of a
-- tenant's data, and the only way in is through the `SECURITY DEFINER` functions
-- in `public`, each of which scopes to the caller's own tenant (or, for
-- `backup_all_tenants` and `export_snapshots_for_offsite`, is revoked from
-- `anon`/`authenticated` and granted only to `service_role`). Postgres does not
-- grant schema `usage` to `PUBLIC` on creation, so this needs no explicit revoke
-- — but do not add one later without reading `0210`'s header first.

create schema if not exists backup;

/* Final shape: `0210`'s create + `tenant_id` (archive `0211`) + `kind`
   (`cloudsql/06`). `payload` is the whole tenant as jsonb; there is no `bytes`
   column — `list_tenant_backups` and `_take` both compute it from the payload
   length, which is why none of the archive files ever added one. */
create table if not exists backup.snapshots (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  label       text,
  table_count int,
  payload     jsonb not null,
  tenant_id   uuid references public.tenants(id) on delete cascade,
  kind        text not null default 'manual'
);

/* The index the archive created alongside `tenant_id`. Every read is
   "this tenant's snapshots, newest first" — `list_tenant_backups`,
   `auto_backup_if_stale`'s staleness check, and `_take`'s own retention
   delete. */
create index if not exists idx_backup_snapshots_tenant
  on backup.snapshots(tenant_id, created_at desc);

/* ─── Which tables a tenant reset may touch ────────────────────────────────
   Verbatim from the live database. `statutory` marks the ones that are books of
   record — an invoice or an attendance row is not the caller's to discard
   casually — and `reset_tenant_selected_tables` refuses a key that is not in
   this list, so the list is an allow-list and not a hint. */
create or replace function backup._resettable()
 returns table(key text, tbl text, statutory boolean)
 language sql
 immutable
as $function$
  values
    ('leads',      'leads',            false),
    ('leads',      'lead_activities',  false),
    ('quotes',     'quotes',           false),
    ('tasks',      'tasks',            false),
    ('expenses',   'expense_claims',   false),
    ('invoices',   'invoices',         true),
    ('attendance', 'attendance',       true)
$function$;

/* ─── The snapshot builder ──────────────────────────────────────────────────
   Verbatim from the live database. Discovers its own tables — anything in
   `public` with a `tenant_id` column — so a table added later is backed up
   without anybody remembering to add it here. `tenant_secrets` is the one
   exclusion, and it is excluded because a snapshot is downloadable. */
create or replace function backup._take(p_tenant uuid, p_label text, p_kind text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
end $function$;

comment on schema backup is
  'Hidden snapshot store. Not API-exposed and no role has usage on it; reachable only through the SECURITY DEFINER functions in public. Captured into the migration history on 11 Sep 2026 — it had existed in production and in migrations-archive/0210+0211 while no replayable migration created it, so a fresh database had all seven public backup functions and nothing for them to read.';
