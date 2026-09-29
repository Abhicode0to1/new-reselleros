-- Regression test: backup_tenant() + export_tenant_snapshot_for_offsite() (S15, 28 Sep 2026).
--
-- WHY THIS FILE EXISTS
--   Raat ka cron ab ek-ek tenant ka backup leta hai aur har tenant ka alag object upload karta
--   hai. Teen cheezein chup-chaap toot sakti hain:
--     1. Pahunch — dono functions KISI BHI tenant ka poora data dete hain. Browser session tak
--        pahunche to ek call me doosre reseller ki kitaabein.
--     2. Retention — 7 se zyada rakhe to DB har raat mota; kam rakhe (ya galat tenant ke
--        mitaye) to undo button chup-chaap chhota.
--     3. Tenant ki deewar — A ke export me B ka snapshot aa jaye to B ka data A ki file me.
--   Needs migration 20260928141000_backup_per_tenant.sql, aur `backup` schema (cloudsql/06).
--
-- SAFETY: apne do fixture tenant banata hai (L11), sab rollback par khatam.

begin;

do $$
begin
  if to_regnamespace('backup') is null then
    raise exception 'NOT APPLICABLE HERE: backup schema is database par nahi hai (baseline defect; Cloud SQL par cloudsql/06 se aata hai)';
  end if;
end $$;

-- ── 1. GRANT ────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['public.backup_tenant(uuid, text)',
                           'public.export_tenant_snapshot_for_offsite(uuid, timestamptz)'] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'FAIL 1: anon % chala sakta hai', f;
    end if;
    if has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL 1: authenticated % chala sakta hai — kisi bhi tenant ka poora data', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'FAIL 1: service_role % nahi chala sakta — raat ka backup chalega hi nahi', f;
    end if;
  end loop;
end $$;

-- Fixture: do tenant, apne.
insert into public.tenants (id, name, email)
values ('5e150000-0000-4000-8000-00000000000a', 'S15 probe A', 's15-a@example.invalid'),
       ('5e150000-0000-4000-8000-00000000000b', 'S15 probe B', 's15-b@example.invalid');

-- ── 2. BODY: browser session ruke ───────────────────────────────────────────
do $$
declare v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '3caa0f07-44d1-42ee-91b3-2123e04853b1', 'role', 'authenticated')::text, true);

  v_msg := null;
  begin perform public.backup_tenant('5e150000-0000-4000-8000-00000000000a', null);
  exception when others then v_msg := sqlerrm; end;
  if coalesce(v_msg, '') not like '%service_role only%' then
    raise exception 'FAIL 2: backup_tenant authenticated session me: %', coalesce(v_msg, 'CHAL GAYA');
  end if;

  v_msg := null;
  begin perform public.export_tenant_snapshot_for_offsite('5e150000-0000-4000-8000-00000000000a', now() - interval '1 day');
  exception when others then v_msg := sqlerrm; end;
  if coalesce(v_msg, '') not like '%service_role only%' then
    raise exception 'FAIL 2: export_tenant_snapshot_for_offsite authenticated session me: %', coalesce(v_msg, 'CHAL GAYA');
  end if;

  perform set_config('request.jwt.claims', '', true);
end $$;

-- ── 3. RETENTION 7, sirf apne tenant par ────────────────────────────────────
set local role service_role;
do $$
declare
  a uuid := '5e150000-0000-4000-8000-00000000000a';
  b uuid := '5e150000-0000-4000-8000-00000000000b';
  r jsonb;
begin
  r := public.backup_tenant(b, 'B only');
  for i in 1..9 loop
    r := public.backup_tenant(a, null);
  end loop;
  if (r->>'tenant_id')::uuid <> a or r->>'label' not like 'Automated Daily Backup - %' then
    raise exception 'FAIL 3: jawab galat tenant/label: %', r - 'payload';
  end if;
  if coalesce((r->>'bytes')::bigint, 0) = 0 then
    raise exception 'FAIL 3: snapshot khaali (bytes 0)';
  end if;
end $$;
reset role;

do $$
declare na int; nb int;
begin
  select count(*) into na from backup.snapshots where tenant_id = '5e150000-0000-4000-8000-00000000000a';
  select count(*) into nb from backup.snapshots where tenant_id = '5e150000-0000-4000-8000-00000000000b';
  if na <> 7 then
    raise exception 'FAIL 3: A ke 9 backup ke baad % snapshot bache — retention 7 hona chahiye', na;
  end if;
  if nb <> 1 then
    raise exception 'FAIL 3: A ki retention ne B ke snapshot chhue (% bache, 1 hona chahiye)', nb;
  end if;
end $$;

-- ── 4. EXPORT: sirf us tenant ka, sabse naya ────────────────────────────────
/* Ek transaction me now() sab snapshot ka ek hi hota hai. B ko ek ghanta purana karo, taaki
   tenant-filter na ho to "sabse naya" A ka nikle aur B wala check laal ho — barabar samay par
   order kuch bhi lauta sakta tha aur galti chhup jaati. */
update backup.snapshots set created_at = now() - interval '1 hour'
 where tenant_id = '5e150000-0000-4000-8000-00000000000b';
set local role service_role;
do $$
declare
  a uuid := '5e150000-0000-4000-8000-00000000000a';
  b uuid := '5e150000-0000-4000-8000-00000000000b';
  x jsonb;
begin
  x := public.export_tenant_snapshot_for_offsite(b, now() - interval '1 day');
  if x is null or (x->>'tenant_id')::uuid <> b or x->>'label' <> 'B only' then
    raise exception 'FAIL 4: B ka export galat: %', x - 'payload';
  end if;
  /* Deewar: B ke payload me sirf B ki tenants row. */
  if jsonb_array_length(x->'payload'->'tenants') <> 1
     or (x->'payload'->'tenants'->0->>'id')::uuid <> b then
    raise exception 'FAIL 4: B ke payload me doosre tenant ki row';
  end if;
  if x->'payload' is null or x->>'tenant_name' <> 'S15 probe B' then
    raise exception 'FAIL 4: payload/tenant_name gayab — upload hota, restore nahi';
  end if;

  x := public.export_tenant_snapshot_for_offsite(a, now() + interval '1 day');
  if x is not null then
    raise exception 'FAIL 4: khidki ke baad ka koi snapshot nahi, phir bhi kuch lautaya';
  end if;
end $$;
reset role;

-- Sabse naya hi aata hai: A ka ek purana-dated snapshot khidki ke andar, naya wala upar.
do $$
declare x jsonb; v_newest uuid;
begin
  update backup.snapshots set created_at = now() - interval '2 hours'
   where tenant_id = '5e150000-0000-4000-8000-00000000000a'
     and id <> (select id from backup.snapshots where tenant_id = '5e150000-0000-4000-8000-00000000000a'
                order by created_at desc, id limit 1);
  select id into v_newest from backup.snapshots where tenant_id = '5e150000-0000-4000-8000-00000000000a'
   order by created_at desc limit 1;
  x := public.export_tenant_snapshot_for_offsite('5e150000-0000-4000-8000-00000000000a', now() - interval '1 day');
  if (x->>'snapshot_id')::uuid <> v_newest then
    raise exception 'FAIL 4: sabse naya snapshot nahi aaya';
  end if;
end $$;

-- ── 5. Anjaan tenant: saaf galti, chup-chaap khaali snapshot nahi ────────────
do $$
declare v_msg text;
begin
  begin perform public.backup_tenant('5e150000-0000-4000-8000-0000000000ff', null);
  exception when others then v_msg := sqlerrm; end;
  if coalesce(v_msg, '') not like '%nahi mila%' then
    raise exception 'FAIL 5: anjaan tenant par: %', coalesce(v_msg, 'snapshot ban gaya');
  end if;
end $$;

select 'PASS' as backup_per_tenant;

rollback;
