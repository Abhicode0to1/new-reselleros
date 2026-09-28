-- Regression test: public.rate_limit_hit() — saanjhi rate-limit ginti (S20, 28 Sep 2026).
--
-- WHY THIS FILE EXISTS
--   Middleware RATE_LIMIT_STORE=postgres par har public request isse ginta hai. Do cheezein
--   toot sakti hain aur dono chup-chaap:
--     1. Pahunch khul jaye (anon/authenticated) — koi bhi kisi aur ki balti bhar kar use 429
--        dila sakta hai, ya table padh kar dekh sakta hai kaun kitna aa raha hai.
--     2. Ginti galat ho — seema kabhi na lage (limiter hai par kaam nahi karta), ya khidki
--        kabhi na khule (asli user hamesha 429).
--   Needs migration 20260928140000_rate_limit_shared_store.sql.
--
-- SAFETY: sab rows is transaction me banti hain, rollback par khatam.

begin;

-- ── 1. GRANT: browser wale role na function chala sakein, na table padh sakein ──
do $$
begin
  if has_function_privilege('anon', 'public.rate_limit_hit(text, integer, integer)', 'execute') then
    raise exception 'FAIL 1: anon rate_limit_hit chala sakta hai';
  end if;
  if has_function_privilege('authenticated', 'public.rate_limit_hit(text, integer, integer)', 'execute') then
    raise exception 'FAIL 1: authenticated rate_limit_hit chala sakta hai';
  end if;
  /* Control: upar ke dono false wo bhi dete jo function hai hi nahi. */
  if not has_function_privilege('service_role', 'public.rate_limit_hit(text, integer, integer)', 'execute') then
    raise exception 'FAIL 1: service_role bhi nahi chala sakta — shared store kabhi chalega hi nahi';
  end if;
  if has_table_privilege('anon', 'public.rate_limit_buckets', 'select')
     or has_table_privilege('authenticated', 'public.rate_limit_buckets', 'select') then
    raise exception 'FAIL 1: browser role rate_limit_buckets padh sakta hai';
  end if;
end $$;

-- ── 2. BODY: grant galti se khul bhi jaye to browser session ruke ────────────
do $$
declare v_blocked boolean := false; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '3caa0f07-44d1-42ee-91b3-2123e04853b1', 'role', 'authenticated')::text, true);
  begin
    perform public.rate_limit_hit('probe', 5, 60000);
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  if not v_blocked then
    raise exception 'FAIL 2: authenticated session me bhi chal gaya — body ka pehra kaam nahi kar raha';
  end if;
  if v_msg not like '%service_role only%' then
    raise exception 'FAIL 2: ruka par galat wajah se: %', v_msg;
  end if;
end $$;

-- ── 3. GINTI: limit 2 → do paas, teesra ruka, retry khidki ke andar ─────────
/* Asli caller ki tarah service_role se — postgres se chalane par grant/auth.uid() ki koi
   kami chhup jaati. Case 4 ka UPDATE table par hai (service_role ka grant nahi), isliye
   role wahan wapas. */
set local role service_role;
do $$
declare
  k text := 'test-fixed-key-s20';
  r record;
begin
  select * into r from public.rate_limit_hit(k, 2, 60000);
  if not r.allowed or r.hits <> 1 then
    raise exception 'FAIL 3: service_role ki pehli koshish % / %', r.allowed, r.hits;
  end if;
end $$;
reset role;

do $$
declare
  k text := 'test-' || gen_random_uuid()::text;
  r record;
begin
  select * into r from public.rate_limit_hit(k, 2, 60000);
  if not r.allowed or r.hits <> 1 or r.retry_after_sec <> 0 then
    raise exception 'FAIL 3: pehli koshish % / % / %', r.allowed, r.hits, r.retry_after_sec;
  end if;
  select * into r from public.rate_limit_hit(k, 2, 60000);
  if not r.allowed or r.hits <> 2 then
    raise exception 'FAIL 3: doosri koshish seema ke andar thi par % / %', r.allowed, r.hits;
  end if;
  select * into r from public.rate_limit_hit(k, 2, 60000);
  if r.allowed then
    raise exception 'FAIL 3: teesri koshish limit 2 par bhi paas — limiter laga hai par kaam nahi karta';
  end if;
  if r.retry_after_sec < 1 or r.retry_after_sec > 60 then
    raise exception 'FAIL 3: retry_after % khidki (60s) ke bahar', r.retry_after_sec;
  end if;

  /* Alag key alag balti — ek IP ka hamla doosre ko 429 na dilaye. */
  select * into r from public.rate_limit_hit(k || '-other', 2, 60000);
  if not r.allowed or r.hits <> 1 then
    raise exception 'FAIL 3: alag key ki ginti mili-juli hai';
  end if;

  -- ── 4. KHIDKI BEETI: ginti nayi ──
  update public.rate_limit_buckets set reset_at = clock_timestamp() - interval '1 second' where key = k;
  select * into r from public.rate_limit_hit(k, 2, 60000);
  if not r.allowed or r.hits <> 1 then
    raise exception 'FAIL 4: khidki beetne ke baad bhi ginti purani (% / %) — asli user hamesha 429', r.allowed, r.hits;
  end if;
end $$;

-- ── 5. GALAT INPUT: chup-chaap "anant" nahi, saaf galti ─────────────────────
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.rate_limit_hit('x', 0, 60000);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: limit 0 maan liya'; end if;
  v_blocked := false;
  begin
    perform public.rate_limit_hit(repeat('a', 500), 5, 60000);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: 500-char key maan li (TS sha256 hex, 64 char bhejta hai)'; end if;
end $$;

select 'PASS' as rate_limit_shared_store;

rollback;
