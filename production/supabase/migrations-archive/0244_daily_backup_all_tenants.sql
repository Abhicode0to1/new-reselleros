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
