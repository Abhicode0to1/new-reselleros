-- Regression test: export_snapshots_for_offsite() sirf service_role ke liye hai.
--
-- WHY THIS FILE EXISTS
--   Is repo ka har doosra RPC ek tenant ka data deta hai. Ye ek HAR tenant ka poora data ek
--   hi call me deta hai — teeno tenants ka har snapshot, ek jsonb me. Wo zaroori hai, kyunki
--   raat wale cron ko sab kuch ek saath Cloud Storage par rakhna hota hai.
--
--   Aur isi wajah se ye is schema ka sabse khatarnak function hai. Agar iski pahunch kabhi
--   khul gayi, to ek hi request me poora platform bahar chala jayega — koi loop nahi, koi
--   ginti nahi, ek call.
--
--   Supabase har naye function par `execute` PUBLIC ko deta hai. Yaani surakshit hona DEFAULT
--   NAHI hai — migration me revoke likhna padta hai, aur wo likhna kabhi bhi chhoot sakta
--   hai: ek `create or replace` jo revoke ke bina aaye, aur darwaza chup-chaap khul jaye.
--   Us din koi error nahi aayega. Sirf ye file laal hogi.
--
-- SAFETY: `backup.snapshots` me fixture row daalta hai (neeche case 3 se pehle), aur
-- kuch nahi badalta. Sab kuch is transaction ke andar hai aur rollback par khatam.

begin;

-- ── 1. GRANT: browser wale role ise chhoo bhi nahi sakte ────────────────────
do $$
begin
  if has_function_privilege('authenticated',
       'public.export_snapshots_for_offsite(timestamptz)', 'execute') then
    raise exception 'FAIL 1: `authenticated` is function ko chala sakta hai — ek hi call me har tenant ka data bahar ja sakta hai';
  end if;

  if has_function_privilege('anon',
       'public.export_snapshots_for_offsite(timestamptz)', 'execute') then
    raise exception 'FAIL 1: `anon` is function ko chala sakta hai — bina login ke poora platform';
  end if;

  /* Control. Upar ke dono `false` wo bhi de dega jo function maujood hi na ho — us soorat me
     ye file "surakshit hai" keh kar pass ho jaati aur backup chup-chaap band pada rehta. */
  if not has_function_privilege('service_role',
       'public.export_snapshots_for_offsite(timestamptz)', 'execute') then
    raise exception 'FAIL 1: service_role bhi nahi chala sakta — to raat ka off-site backup kabhi chala hi nahi hoga';
  end if;
end $$;

-- ── 2. BODY: grant khul bhi jaye to browser session phir bhi ruke ───────────
do $$
declare v_blocked boolean := false; v_msg text;
begin
  /* Ye doosra pehra hai, aur ise alag se naapna zaroori hai: case 1 grant jaanchta hai,
     ye body jaanchta hai. Ek din koi migration `grant execute ... to authenticated` likh
     de, to case 1 laal hoga aur ye hara — dono milkar batayenge ki kya toota. */
  /* Koi bhi uuid kaafi hai — is case ko sirf ITNA chahiye ki `auth.uid()` NULL na ho,
     taaki function ke body ka pehra chale. Pehle yahan ek ASLI karmchari ka account id
     pada tha (`3caa0f07-…`), jiski zaroorat hi nahi thi: ye user maujood ho ya na ho,
     test ka nateeja wahi rehta hai. Reserved fixture namespace se lena isliye behtar hai
     ki koi ise "live data chahiye" na samjhe. */
  perform set_config('request.jwt.claims',
    json_build_object('sub', '7e57e57e-0004-4000-8000-000000000004',
                      'role', 'authenticated')::text, true);
  begin
    perform public.export_snapshots_for_offsite(now() - interval '1 day');
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;

  if not v_blocked then
    raise exception 'FAIL 2: auth.uid() maujood hone par bhi function chal gaya — body ka pehra kaam nahi kar raha';
  end if;
  if v_msg not like '%service_role only%' then
    raise exception 'FAIL 2: ruka to sahi, par galat wajah se: %', v_msg;
  end if;

  /* Khaali string par chhoda jata hai, jaan-boojhkar. Ye wahi haalat hai jisme pehli baar
     ye test 22P02 se mara: `set_config(..., null, ...)` NULL nahi, KHAALI STRING set karta
     hai, aur function usi ko jsonb me badal raha tha. Ab wo `nullif` se sambhala hua hai,
     aur ye line us fix ki gawah hai — hataoge to fix ka koi saboot nahi bachega. */
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ── 2a. FIXTURE: har tenant ka ek snapshot ─────────────────────────
--
-- 11 Sep 2026 ko joda gaya. Case 3 pehle ASLI data par tika hua tha — "ek saal me koi
-- snapshot mila ya nahi". Wo production par chalta tha kyunki wahan raat ka sweep chal
-- raha hai, aur ek TAAZA database par hamesha laal hota tha: khaali `backup.snapshots`
-- par test kehta tha "sweep chala hi nahi", jabki sach ye tha ki is database me kabhi
-- kuch chala hi nahi.
--
-- Do alag sawaal ek assertion me mile hue the:
--   (a) function ka SHAPE sahi hai kya  — ye regression test ka kaam hai
--   (b) prod par cron chal raha hai kya — ye MONITORING ka kaam hai
--
-- (a) ke liye data khud banaya jata hai, to case 3 har jagah poori taakat se chalta hai.
-- (b) is file me ab NAHI hai, aur wo jaan-boojh kar hai — rollback wale test se cron ki
-- sehat naapna galat jagah hai. Wo abhi kahin bhi covered NAHI hai; `lib/ops/health-digest.ts`
-- uska ghar hai, aur ye us kaam ka nishaan hai.
--
-- Prod par snapshot pehle se hote hain; ye row unse NAYI hai, isliye
-- `distinct on (tenant_id) order by created_at desc` isi ko chunega. Yaani dono jagah
-- ek jaisa vyavhaar, bina prod ke data par bharosa kiye.
-- DO row per tenant, jaan-boojh kar. Ek se `distinct on (tenant_id)` ki jaanch NAKLI ho
-- jaati hai: agar function poora itihaas lauta de, ek-row-per-tenant par ginti bilkul
-- wahi dikhti hai jo sahi jawab me hoti. Do row par galti pakdi jaati hai — aur label se
-- ye bhi saabit hota hai ki NAYA chuna gaya, purana nahi. Wo baat pehle kisi bhi
-- assertion se saabit nahi hoti thi.
insert into backup.snapshots (tenant_id, label, kind, table_count, payload, created_at)
select t.id, 'fixture PURANA — ye nahi jana chahiye', 'auto', 1,
       jsonb_build_object('tenants', jsonb_build_array(jsonb_build_object('id', t.id))),
       now() - interval '2 days'
from public.tenants t;

insert into backup.snapshots (tenant_id, label, kind, table_count, payload, created_at)
select t.id, 'fixture NAYA — yahi jana chahiye', 'auto', 1,
       jsonb_build_object('tenants', jsonb_build_array(jsonb_build_object('id', t.id))),
       now()
from public.tenants t;

-- ── 3. Jo lautata hai wo sach me kaam ka ho ─────────────────────────────────
do $$
declare
  v_out      jsonb;
  v_tenants  int;
  v_distinct int;
  v_empty    int;
begin
  /* Poore itihaas ki khidki. Case 2a ki row `now()` par hai, to ye usse hamesha andar leta hai. */
  v_out := public.export_snapshots_for_offsite(now() - interval '365 days');

  if jsonb_typeof(v_out) <> 'array' then
    raise exception 'FAIL 3: array nahi, % mila', jsonb_typeof(v_out);
  end if;
  if jsonb_array_length(v_out) = 0 then
    /* Ab ye do-matlab wala nahi hai. Case 2a ne HAR tenant ka snapshot daala hai, to
       khaali aana ek hi cheez ka matlab hai: function padh nahi paa raha. */
    raise exception 'FAIL 3: fixture daalne ke BAAD bhi ek bhi snapshot nahi — function galat jagah dekh raha hai';
  end if;

  /* Har tenant ka SIRF EK (sabse naya). Poora itihaas bhejna har raat pichhli raaton ki
     nakal dobara upload karta — off-site copy roz badhti, bina kisi naye saboot ke. */
  select count(distinct x->>'tenant_id') into v_distinct
    from jsonb_array_elements(v_out) x;
  if v_distinct <> jsonb_array_length(v_out) then
    raise exception 'FAIL 3: % row par sirf % tenant — kisi tenant ke ek se zyada snapshot ja rahe hain',
      jsonb_array_length(v_out), v_distinct;
  end if;

  /* Khaali payload wala snapshot ek backup jaisa dikhta hai aur backup hai nahi. Ye wahi
     shakl hai jisme 19 Aug tak laptop wala dump chup-chaap tootA pada tha. */
  select count(*) into v_empty from jsonb_array_elements(v_out) x
   where x->'payload' is null or jsonb_typeof(x->'payload') = 'null'
      or x->>'tenant_name' is null;
  if v_empty > 0 then
    raise exception 'FAIL 3: % snapshot bina payload/naam ke — upload to hoga, restore nahi', v_empty;
  end if;

  select count(*) into v_tenants from public.tenants;
  if v_distinct <> v_tenants then
    raise exception 'FAIL 3: % tenant hain par sirf % ka backup ja raha hai', v_tenants, v_distinct;
  end if;

  /* Aur NAYA hi chuna gaya, purana nahi. `distinct on` ke saath `order by` galat likha ho
     to ye function chalega, array ka size bilkul sahi hoga, aur wo har raat MAHINE PURANA
     snapshot off-site bhejta rahega. Us galti ka koi doosra lakshan nahi hai. */
  select count(*) into v_empty from jsonb_array_elements(v_out) x
   where x->>'label' like 'fixture PURANA%';
  if v_empty > 0 then
    raise exception 'FAIL 3: % tenant ka PURANA snapshot bheja gaya — distinct on ka order galat hai', v_empty;
  end if;
end $$;

-- ── 4. p_since sach me chhaanti karta hai ───────────────────────────────────
do $$
declare v_out jsonb;
begin
  /* Bina is jaanch ke case 3 tab bhi pass hota jab p_since ko poori tarah anadekha kiya ja
     raha ho — aur tab har raat poora itihaas upload hota rehta. */
  v_out := public.export_snapshots_for_offsite(now() + interval '1 day');
  if jsonb_array_length(v_out) <> 0 then
    raise exception 'FAIL 4: bhavishya ki tareekh par bhi % snapshot mile — p_since padha hi nahi ja raha',
      jsonb_array_length(v_out);
  end if;
end $$;

select 'PASS' as offsite_export_service_role_only;

rollback;
