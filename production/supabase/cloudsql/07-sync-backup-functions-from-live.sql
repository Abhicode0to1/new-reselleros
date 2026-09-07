-- ============================================================================
--  07 · Backup-subsystem functions, synced VERBATIM from the live source DB
--  RUN AS postgres (switches to resellersos_migration itself).
--  Why: 06 replayed ARCHIVE migrations and one live function had a newer return
--  type ("cannot change return type"); others may have been downgraded. This file
--  re-creates every backup-related function from pg_get_functiondef on the live
--  source, so Cloud SQL matches production behaviour exactly.
-- ============================================================================
\set ON_ERROR_STOP on
GRANT resellersos_migration TO postgres;
SET ROLE resellersos_migration;
SELECT current_user AS running_as;
\set ON_ERROR_STOP off

DROP FUNCTION IF EXISTS backup._resettable();
CREATE OR REPLACE FUNCTION backup._resettable()
 RETURNS TABLE(key text, tbl text, statutory boolean)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  values
    ('leads',      'leads',            false),
    ('leads',      'lead_activities',  false),
    ('quotes',     'quotes',           false),
    ('tasks',      'tasks',            false),
    ('expenses',   'expense_claims',   false),
    ('invoices',   'invoices',         true),
    ('attendance', 'attendance',       true)
$function$;

DROP FUNCTION IF EXISTS backup._take(p_tenant uuid, p_label text, p_kind text);
CREATE OR REPLACE FUNCTION backup._take(p_tenant uuid, p_label text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

DROP FUNCTION IF EXISTS public.auto_backup_if_stale();
CREATE OR REPLACE FUNCTION public.auto_backup_if_stale()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

DROP FUNCTION IF EXISTS public.backup_all_tenants(p_label text);
CREATE OR REPLACE FUNCTION public.backup_all_tenants(p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

DROP FUNCTION IF EXISTS public.create_tenant_backup(p_label text);
CREATE OR REPLACE FUNCTION public.create_tenant_backup(p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_tenant uuid; v_role text;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can take a backup'; end if;
  return backup._take(v_tenant, coalesce(p_label, 'Manual backup'), 'manual');
end $function$;

DROP FUNCTION IF EXISTS public.delete_tenant_backup(p_id uuid);
CREATE OR REPLACE FUNCTION public.delete_tenant_backup(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  delete from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$function$;

DROP FUNCTION IF EXISTS public.export_snapshots_for_offsite(p_since timestamp with time zone);
CREATE OR REPLACE FUNCTION public.export_snapshots_for_offsite(p_since timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

DROP FUNCTION IF EXISTS public.get_tenant_backup(p_id uuid);
CREATE OR REPLACE FUNCTION public.get_tenant_backup(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select payload from backup.snapshots
  where id = p_id and tenant_id = (select tenant_id from public.users where id = auth.uid());
$function$;

DROP FUNCTION IF EXISTS public.list_tenant_backups();
CREATE OR REPLACE FUNCTION public.list_tenant_backups()
 RETURNS TABLE(id uuid, created_at timestamp with time zone, label text, kind text, table_count integer, bytes integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id, s.created_at, s.label, s.kind, s.table_count, length(s.payload::text)
  from backup.snapshots s
  where s.tenant_id = (select tenant_id from public.users where id = auth.uid())
  order by s.created_at desc;
$function$;

DROP FUNCTION IF EXISTS public.reset_tenant_selected_tables(p_tables text[], p_label text, p_confirm_statutory boolean);
CREATE OR REPLACE FUNCTION public.reset_tenant_selected_tables(p_tables text[], p_label text, p_confirm_statutory boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  select array_agg(t) into v_bad
  from unnest(p_tables) t
  where t not in (select key from backup._resettable());

  if v_bad is not null then
    raise exception 'Not resettable: %. Allowed: %',
      array_to_string(v_bad, ', '),
      (select string_agg(distinct key, ', ' order by key) from backup._resettable());
  end if;

  select array_agg(distinct key) into v_stat
  from backup._resettable()
  where statutory and key = any(p_tables);

  if v_stat is not null and not p_confirm_statutory then
    raise exception
      'Refusing to reset % — these are statutory records (GST invoice series must have no gaps; attendance backs payroll). Re-run with the statutory confirmation if you are certain.',
      array_to_string(v_stat, ', ');
  end if;

  v_backup := backup._take(v_tenant, 'Pre-Reset Safeguard Snapshot - ' || coalesce(p_label, 'unlabelled'), 'pre_reset');

  if v_backup is null
     or coalesce((v_backup->>'bytes')::bigint, 0) = 0
     or coalesce((v_backup->>'table_count')::int, 0) = 0 then
    raise exception 'Pre-reset backup produced an empty snapshot — refusing to delete anything. Nothing has been changed.';
  end if;

  for r in
    select tbl from backup._resettable() where key = any(p_tables)
  loop
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
end $function$;

DROP FUNCTION IF EXISTS public.restore_tenant_backup(p_id uuid);
CREATE OR REPLACE FUNCTION public.restore_tenant_backup(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid; v_role text; v_payload jsonb; r record; col_list text; has_identity bool; n int := 0;
begin
  select tenant_id, role into v_tenant, v_role from public.users where id = auth.uid();
  if v_tenant is null then raise exception 'No tenant for caller'; end if;
  if coalesce(v_role, '') <> 'owner' then raise exception 'Only the owner can restore'; end if;
  select payload into v_payload from backup.snapshots where id = p_id and tenant_id = v_tenant;
  if v_payload is null then raise exception 'Restore point not found'; end if;

  perform backup._take(v_tenant, 'Before restore ' || to_char(now(), 'DD Mon HH24:MI'), 'auto');

  set local session_replication_role = replica;

  for r in
    select c.table_name from information_schema.columns c
    join pg_tables pt on pt.schemaname='public' and pt.tablename=c.table_name
    where c.table_schema='public' and c.column_name='tenant_id' and c.table_name not in ('tenant_secrets','users')
    group by c.table_name order by c.table_name
  loop
    if not (v_payload ? r.table_name) then continue; end if;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position), bool_or(is_identity = 'YES')
      into col_list, has_identity
    from information_schema.columns
    where table_schema='public' and table_name = r.table_name and is_generated <> 'ALWAYS';
    execute format('delete from public.%I where tenant_id = $1', r.table_name) using v_tenant;
    execute format(
      'insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1)',
      r.table_name, col_list, case when has_identity then 'overriding system value' else '' end, col_list, r.table_name
    ) using (v_payload -> r.table_name);
    n := n + 1;
  end loop;

  set local session_replication_role = origin;
  return jsonb_build_object('restored_tables', n, 'restored_at', now());
end $function$;

-- ----------------------------------------------------------------------------
-- Access control, copied verbatim from the migrations that own these functions
-- (0241_pre_reset_backup_shield.sql, 0244_daily_backup_all_tenants.sql,
--  20260829040000_offsite_backup_export.sql). service_role-only on the
-- dangerous ones — this is the security boundary.
-- ----------------------------------------------------------------------------
revoke all on function public.reset_tenant_selected_tables(text[], text, boolean) from public;
grant execute on function public.reset_tenant_selected_tables(text[], text, boolean) to authenticated;
revoke all on function public.backup_all_tenants(text) from public, anon, authenticated;
grant execute on function public.backup_all_tenants(text) to service_role;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from public;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from anon;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from authenticated;
grant execute on function public.export_snapshots_for_offsite(timestamptz) to service_role;

RESET ROLE;
