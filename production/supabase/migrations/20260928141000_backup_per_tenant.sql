-- S15 (28 Sep 2026) — backup ek-ek tenant karke; in-DB retention 30 → 7.
--
-- ─── KYUN ───────────────────────────────────────────────────────────────────
-- Aaj raat ka cron `backup_all_tenants()` ek RPC call hai = EK transaction, jisme har tenant
-- ka `_take` (145 tables ka ek jsonb) chalta hai. Phir `export_snapshots_for_offsite()` sab
-- tenants ke snapshot EK jsonb me lautata hai, jo Cloud Run ki RAM me ek string banta hai.
-- 3 tenant par ~250 kB — theek. 50 tenant par: ek lamba transaction jo har tenant ki locks
-- aur WAL ek saath pakde, aur jsonb ki 1 GB seema ki taraf badhta ek object. Fail wahi din
-- hoga jis din data sabse zyada hoga.
--
-- Naya raasta (cron ab ye bulata hai, lib/backup/per-tenant.ts):
--   · `backup_tenant(tenant)`                     — ek tenant, ek transaction (har RPC call alag)
--   · `export_tenant_snapshot_for_offsite(tenant)`— us ek tenant ka sabse naya snapshot
--   · GCS me har tenant ka alag object: daily/YYYY-MM-DD/<tenant_id>.json
-- Purane `backup_all_tenants` / `export_snapshots_for_offsite` jaan-boojh kar RAKHE hain:
-- cron ka fallback (ye migration na chali ho to) aur unke apne tests.
--
-- ─── RETENTION 7 ────────────────────────────────────────────────────────────
-- `backup.snapshots` usi DB me hai — undo button hai, backup nahi. 30 copy × 50 tenant usi
-- DB ka size aur har `_take` ka delete bhaari karte. Asli lamba itihaas off-site bucket
-- (daily/ 400 din, monthly/ 8 saal) aur Cloud SQL PITR (S4) me hai. TS mirror:
-- SNAPSHOT_RETENTION (lib/queries/backups.ts) — dono saath badlo.
--
-- ─── backup schema na ho to ──────────────────────────────────────────────────
-- baseline.sql me `backup` schema nahi hai (rebuild ka jaana-maana defect); Cloud SQL par
-- cloudsql/06 + 07 se aata hai. `_take` ka redefine isliye `to_regnamespace` ke pehre me hai —
-- warna staging rebuild is file par ruk jaata. Naye public functions plpgsql hain; unki body
-- create ke waqt table nahi dhoondhti, to wo har jagah ban jaate hain.

-- ── 1. backup._take — wahi body (cloudsql/07, live se), sirf `limit 30` → `limit 7` ──
do $do$
begin
  if to_regnamespace('backup') is null then
    raise notice 'S15: backup schema nahi hai — _take retention change chhoda (cloudsql/06 pehle chalao)';
    return;
  end if;

  execute $fn$
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

  -- S15 (28 Sep 2026): newest 7 restore points per tenant (was 30). Mirrored in TypeScript
  -- as SNAPSHOT_RETENTION (lib/queries/backups.ts) — change both together.
  delete from backup.snapshots s
  where s.tenant_id = p_tenant
    and s.id not in (select id from backup.snapshots where tenant_id = p_tenant order by created_at desc limit 7);

  return jsonb_build_object('id', v_id, 'table_count', n, 'bytes', length(result::text), 'created_at', now());
end $function$
$fn$;
end
$do$;

-- ── 2. backup_tenant — ek tenant ka raat wala snapshot, apne transaction me ──
create or replace function public.backup_tenant(p_tenant uuid, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_name  text;
  v_label text := coalesce(nullif(btrim(p_label), ''),
                           'Automated Daily Backup - ' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'));
  v_snap  jsonb;
begin
  /* Doosra pehra (asli deewar grant hai). Ye kisi bhi tenant ka snapshot le sakta hai —
     browser session se kabhi nahi chalna chahiye. */
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'backup_tenant is service_role only';
  end if;

  select name into v_name from public.tenants where id = p_tenant;
  if not found then
    raise exception 'backup_tenant: tenant % nahi mila — tenants list dobara padho (shayad abhi delete hua)', p_tenant;
  end if;

  v_snap := backup._take(p_tenant, v_label, 'auto');
  return v_snap || jsonb_build_object('tenant_id', p_tenant, 'tenant_name', v_name, 'label', v_label);
end;
$$;

comment on function public.backup_tenant(uuid, text) is
  'S15: ek tenant ka nightly snapshot (backup._take, kind=auto). service_role only — cron/backup ek-ek tenant karke bulata hai. Test: supabase/tests/backup_per_tenant.test.sql';

revoke all on function public.backup_tenant(uuid, text) from public;
revoke all on function public.backup_tenant(uuid, text) from anon;
revoke all on function public.backup_tenant(uuid, text) from authenticated;
grant execute on function public.backup_tenant(uuid, text) to service_role;

-- ── 3. export_tenant_snapshot_for_offsite — ek tenant, sabse naya snapshot ──
create or replace function public.export_tenant_snapshot_for_offsite(p_tenant uuid, p_since timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_out  jsonb;
begin
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'export_tenant_snapshot_for_offsite is service_role only';
  end if;

  /* Shakl wahi jo export_snapshots_for_offsite ke har element ki hai — taaki envelope aur
     scripts/gen-restore-rehearsal.cjs bina badle chalein. Koi snapshot nahi → NULL (cron
     use "is tenant ka backup nahi bana" ginta hai, khaali object upload nahi karta). */
  select jsonb_build_object(
           'tenant_id',   s.tenant_id,
           'tenant_name', t.name,
           'snapshot_id', s.id,
           'created_at',  s.created_at,
           'label',       s.label,
           'kind',        s.kind,
           'table_count', s.table_count,
           'payload',     s.payload)
    into v_out
  from backup.snapshots s
  join public.tenants t on t.id = s.tenant_id
  where s.tenant_id = p_tenant and s.created_at >= p_since
  order by s.created_at desc
  limit 1;

  return v_out;
end;
$$;

comment on function public.export_tenant_snapshot_for_offsite(uuid, timestamptz) is
  'S15: ek tenant ka sabse naya snapshot (p_since ke baad) off-site upload ke liye; NULL = koi nahi. service_role only.';

revoke all on function public.export_tenant_snapshot_for_offsite(uuid, timestamptz) from public;
revoke all on function public.export_tenant_snapshot_for_offsite(uuid, timestamptz) from anon;
revoke all on function public.export_tenant_snapshot_for_offsite(uuid, timestamptz) from authenticated;
grant execute on function public.export_tenant_snapshot_for_offsite(uuid, timestamptz) to service_role;
