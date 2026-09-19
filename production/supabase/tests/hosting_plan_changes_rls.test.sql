-- Regression test: who can see and write a hosting upgrade request.
--   migration 20260911140000 · table `hosting_plan_changes`
--
-- Kya saabit hota hai (self-asserting, sab rollback):
--   1. Customer APNI request padh sakta hai — bina iske portal "aapne pehle hi
--      maanga hai" dikha nahi sakta, aur customer button dobara dabayega.
--   2. Customer DOOSRE customer ki request nahi padh sakta. Yahi is table ka
--      sabse mehnga risav hoga: domain naam, plan, aur email.
--   3. Customer INSERT nahi kar sakta. Koi insert policy nahi hai, jaan-boojh kar
--      — warna koi bhi logged-in customer kisi aur ke account par request bana
--      sakta tha. Route service_role se likhta hai.
--   4. Customer UPDATE nahi kar sakta — warna wo apni hi request 'approved'
--      kar leta, aur approve karna paisa aur server dono badalta hai.
--   5. Staff apne tenant ki request dekhta hai, doosre tenant ki NAHI.
--   6. Ek account par DO pending request nahi ban sakti (partial unique index) —
--      warna do approval, do charge, ek upgrade.
--
-- SAFETY: sab kuch is transaction ke andar, rollback par khatam. Fixture id
-- reserved namespace (7e57e57e-…) me hain.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── Do tenant, do customer, do hosting account ────────────────────────────
insert into public.tenants (id, name, email, state_code)
  values ('7e57e57e-7001-4000-8000-000000000001'::uuid, 'UPG CO A', 'a@upg.in', '07'),
         ('7e57e57e-7002-4000-8000-000000000002'::uuid, 'UPG CO B', 'b@upg.in', '07');

insert into public.customers (id, tenant_id, name, contact_email)
  values ('7e57e57e-7003-4000-8000-000000000003'::uuid, '7e57e57e-7001-4000-8000-000000000001'::uuid, 'Cust A', 'ca@upg.in'),
         ('7e57e57e-7004-4000-8000-000000000004'::uuid, '7e57e57e-7002-4000-8000-000000000002'::uuid, 'Cust B', 'cb@upg.in');

-- Each test makes its own auth user; borrowing one is what broke
-- portal_set_auto_renew on 11 Sep (customer_users.auth_user_id is UNIQUE).
insert into auth.users (id, email)
  values ('7e57e57e-7005-4000-8000-000000000005'::uuid, 'upg-a@example.test'),
         ('7e57e57e-7006-4000-8000-000000000006'::uuid, 'upg-b@example.test');

insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role)
  values ('7e57e57e-7005-4000-8000-000000000005'::uuid, '7e57e57e-7003-4000-8000-000000000003'::uuid,
          '7e57e57e-7001-4000-8000-000000000001'::uuid, 'ca@upg.in', 'admin'),
         ('7e57e57e-7006-4000-8000-000000000006'::uuid, '7e57e57e-7004-4000-8000-000000000004'::uuid,
          '7e57e57e-7002-4000-8000-000000000002'::uuid, 'cb@upg.in', 'admin');

insert into public.hosting_accounts (id, tenant_id, customer_id, domain_name, quote_id, status, plan_code, da_username)
  values ('7e57e57e-7007-4000-8000-000000000007'::uuid, '7e57e57e-7001-4000-8000-000000000001'::uuid,
          '7e57e57e-7003-4000-8000-000000000003'::uuid, 'site-a.in', 'Q-UPG-A', 'active', 'starter', 'sitea'),
         ('7e57e57e-7008-4000-8000-000000000008'::uuid, '7e57e57e-7002-4000-8000-000000000002'::uuid,
          '7e57e57e-7004-4000-8000-000000000004'::uuid, 'site-b.in', 'Q-UPG-B', 'active', 'starter', 'siteb'),
         /* Customer A ka DOOSRA account, jiski koi pending request NAHI hai.
            Case 3 isi par insert karta hai — aur wajah zaroori hai: pehle wo
            'site-b.in' par karta tha, jiski pending request maujood thi, to
            unique index use rok deta tha aur insert-policy ka test NAKLI ho jata
            (mutation me wo `unique_violation` se laal hua, `insufficient_privilege`
            se nahi). Yahan use rokne wali ek hi cheez bachi hai: insert policy ka
            NA HONA. Aur ye customer ka APNA account hai, yaani sabse sakht shakl
            — apne hi account par bhi seedha insert nahi. */
         ('7e57e57e-700c-4000-8000-00000000000c'::uuid, '7e57e57e-7001-4000-8000-000000000001'::uuid,
          '7e57e57e-7003-4000-8000-000000000003'::uuid, 'site-a2.in', 'Q-UPG-A2', 'active', 'starter', 'sitea2');

-- One request per tenant, written the way the route writes them.
insert into public.hosting_plan_changes
  (id, tenant_id, hosting_account_id, customer_id, domain_name, from_plan_code, requested_plan_code, requested_by_email)
  values ('7e57e57e-7009-4000-8000-000000000009'::uuid, '7e57e57e-7001-4000-8000-000000000001'::uuid,
          '7e57e57e-7007-4000-8000-000000000007'::uuid, '7e57e57e-7003-4000-8000-000000000003'::uuid,
          'site-a.in', 'starter', 'plus', 'ca@upg.in'),
         ('7e57e57e-700a-4000-8000-00000000000a'::uuid, '7e57e57e-7002-4000-8000-000000000002'::uuid,
          '7e57e57e-7008-4000-8000-000000000008'::uuid, '7e57e57e-7004-4000-8000-000000000004'::uuid,
          'site-b.in', 'starter', 'standard', 'cb@upg.in');

-- ── 6. Ek account par doosri pending request BAN NAHI SAKTI ───────────────
-- service_role ke roop me, yaani policy ka sawaal nahi — index ka hai.
do $$
begin
  begin
    insert into public.hosting_plan_changes
      (tenant_id, hosting_account_id, customer_id, domain_name, requested_plan_code)
      values ('7e57e57e-7001-4000-8000-000000000001'::uuid, '7e57e57e-7007-4000-8000-000000000007'::uuid,
              '7e57e57e-7003-4000-8000-000000000003'::uuid, 'site-a.in', 'standard');
    raise exception 'FAIL 6: ek hi account par doosri PENDING request ban gayi — do approval, do charge, ek upgrade';
  exception when unique_violation then null;   -- yahi chahiye
  end;

  /* Aur wahi index decided request ko nahi rokta — warna customer dobara kabhi
     upgrade maang hi nahi sakta. Partial index isi ke liye hai. */
  update public.hosting_plan_changes set status = 'rejected'
   where id = '7e57e57e-7009-4000-8000-000000000009'::uuid;
  insert into public.hosting_plan_changes
    (tenant_id, hosting_account_id, customer_id, domain_name, requested_plan_code)
    values ('7e57e57e-7001-4000-8000-000000000001'::uuid, '7e57e57e-7007-4000-8000-000000000007'::uuid,
            '7e57e57e-7003-4000-8000-000000000003'::uuid, 'site-a.in', 'standard');
  /* Wapas pending, taaki neeche ke RLS test asli haalat par chalen. */
  delete from public.hosting_plan_changes
   where hosting_account_id = '7e57e57e-7007-4000-8000-000000000007'::uuid
     and id <> '7e57e57e-7009-4000-8000-000000000009'::uuid;
  update public.hosting_plan_changes set status = 'pending'
   where id = '7e57e57e-7009-4000-8000-000000000009'::uuid;
end $$;

-- ══ CUSTOMER A ke roop me ═════════════════════════════════════════════════
select set_config('request.jwt.claims',
  '{"sub":"7e57e57e-7005-4000-8000-000000000005","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n integer; v_id uuid;
begin
  -- Control: context sach me bana hai. Bina iske neeche ka har `0 rows` khali
  -- session ki wajah se pass ho jata aur kuch bhi saabit na hota.
  if public.current_customer_id() is distinct from '7e57e57e-7003-4000-8000-000000000003'::uuid then
    raise exception 'FAIL 0: customer context nahi bana (current_customer_id = %)', public.current_customer_id();
  end if;

  -- ── 1. Apni request dikhti hai ─────────────────────────────────────────
  select count(*) into n from public.hosting_plan_changes
   where id = '7e57e57e-7009-4000-8000-000000000009'::uuid;
  if n <> 1 then
    raise exception 'FAIL 1: customer ko apni request nahi dikhi (% rows) — portal "pehle hi maanga hai" nahi dikha payega', n;
  end if;

  -- ── 2. Doosre customer ki NAHI ─────────────────────────────────────────
  select count(*) into n from public.hosting_plan_changes
   where id = '7e57e57e-700a-4000-8000-00000000000a'::uuid;
  if n <> 0 then
    raise exception 'FAIL 2: doosre customer ki request dikh rahi hai (% rows) — domain, plan aur email ka risav', n;
  end if;

  -- Aur poori table par bhi sirf ek hi.
  select count(*) into n from public.hosting_plan_changes;
  if n <> 1 then
    raise exception 'FAIL 2b: customer ko kul % request dikhi, sirf 1 dikhni chahiye', n;
  end if;

  -- ── 3. INSERT nahi kar sakta — APNE account par bhi nahi ───────────────
  /* site-a2.in par koi pending request nahi hai, to unique index yahan raasta
     nahi rokta. Sirf insert policy ka na hona rokta hai — aur yahi naapna hai. */
  begin
    insert into public.hosting_plan_changes
      (tenant_id, hosting_account_id, customer_id, domain_name, requested_plan_code)
      values ('7e57e57e-7001-4000-8000-000000000001'::uuid, '7e57e57e-700c-4000-8000-00000000000c'::uuid,
              '7e57e57e-7003-4000-8000-000000000003'::uuid, 'site-a2.in', 'plus');
    raise exception 'FAIL 3: customer ne SEEDHA request bana di — koi insert policy nahi honi chahiye, route service_role se likhta hai';
  exception
    when insufficient_privilege then null;   -- yahi chahiye
    when unique_violation then
      /* Ye bhi laal hai. Iska matlab hai ki insert ROKA index ne, policy ne nahi
         — yaani ye test insert-policy ko naap hi nahi raha tha. */
      raise exception 'FAIL 3: insert ko unique index ne roka, RLS ne nahi — fixture galat hai, test naqli ho gaya';
  end;

  /* Aur DOOSRE ke account par bhi nahi — do alag baatein: upar "insert nahi kar
     sakta", yahan "kisi aur ke account par bhi nahi". Pehla fail ho aur doosra
     pass, aisa nahi ho sakta, par ulta ho sakta hai. */
  begin
    insert into public.hosting_plan_changes
      (tenant_id, hosting_account_id, customer_id, domain_name, requested_plan_code)
      values ('7e57e57e-7002-4000-8000-000000000002'::uuid, '7e57e57e-7008-4000-8000-000000000008'::uuid,
              '7e57e57e-7004-4000-8000-000000000004'::uuid, 'site-b.in', 'plus');
    raise exception 'FAIL 3b: customer ne DOOSRE customer ke account par request bana di';
  exception when insufficient_privilege or unique_violation then null;
  end;

  -- ── 4. UPDATE nahi kar sakta ───────────────────────────────────────────
  /* Sabse mehnga: apni request khud 'approved' kar dena. Approve karna
     DirectAdmin ka package badalta hai aur quote banata hai. */
  update public.hosting_plan_changes set status = 'approved'
   where id = '7e57e57e-7009-4000-8000-000000000009'::uuid;
  select count(*) into n from public.hosting_plan_changes
   where id = '7e57e57e-7009-4000-8000-000000000009'::uuid and status = 'approved';
  if n <> 0 then
    raise exception 'FAIL 4: customer ne apni hi request approve kar li — ye package badalta hai aur charge banata hai';
  end if;
end $$;

reset role;

-- ══ STAFF (tenant A) ke roop me ═══════════════════════════════════════════
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
reset role;

insert into auth.users (id, email)
  values ('7e57e57e-700b-4000-8000-00000000000b'::uuid, 'staff-a@example.test');
insert into public.users (id, tenant_id, email, full_name, role)
  values ('7e57e57e-700b-4000-8000-00000000000b'::uuid, '7e57e57e-7001-4000-8000-000000000001'::uuid,
          'staff-a@example.test', 'Staff A', 'owner');

select set_config('request.jwt.claims',
  '{"sub":"7e57e57e-700b-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;

do $$
declare n integer;
begin
  -- Control again: the staff context is real.
  if public.current_tenant_id() is distinct from '7e57e57e-7001-4000-8000-000000000001'::uuid then
    raise exception 'FAIL 5a: staff tenant context nahi bana (%)', public.current_tenant_id();
  end if;

  -- ── 5. Apne tenant ki dikhti hai, doosre ki nahi ───────────────────────
  select count(*) into n from public.hosting_plan_changes
   where id = '7e57e57e-7009-4000-8000-000000000009'::uuid;
  if n <> 1 then
    raise exception 'FAIL 5b: staff ko apne tenant ki request nahi dikhi (% rows) — queue khali dikhegi', n;
  end if;

  select count(*) into n from public.hosting_plan_changes
   where id = '7e57e57e-700a-4000-8000-00000000000a'::uuid;
  if n <> 0 then
    raise exception 'FAIL 5c: staff ko DOOSRE tenant ki request dikhi (% rows) — cross-tenant risav', n;
  end if;
end $$;

reset role;
rollback;
