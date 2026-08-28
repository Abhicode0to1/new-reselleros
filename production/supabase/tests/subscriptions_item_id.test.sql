-- Regression test: subscriptions.item_id + the resolve trigger (migration 0248).
-- Run on a dev/test DB. Self-asserting; rolled back.
--
-- Proves:
--   1. plan_key() agrees with planKey() in lib/subscriptions/plan-match.ts — including
--      the case the whole change exists for: "Business Standard" == "Standard".
--   2. The trigger links a subscription whose plan name does NOT exactly match the
--      catalog ("Google Workspace Business Standard" -> "Google Workspace Standard").
--   3. It REFUSES to link three Enterprise tiers onto the one Enterprise row.
--   4. It never links across vendors — the ₹0-hosting-cost-on-a-Google-seat bug.
--   5. It declines when two catalog rows are ambiguous, rather than picking one.
--   6. An explicitly supplied item_id is never overwritten.
--   7. Correcting the plan re-points the link (UPDATE fires it too).
--   8. The FK is tenant-safe: another tenant's item id is rejected outright.
--   9. It works as `authenticated`, not just as service_role — the trigger runs with
--      INVOKER rights, so a real client insert reads `items` through RLS. Tests 2-8
--      run as service_role, which bypasses RLS and would happily hide a permission
--      failure that breaks every subscription created from the browser.

-- ── 1. plan_key() ───────────────────────────────────────────────────────────
begin;
do $$
begin
  -- The case the change exists for: the dialog's name and the catalog's collapse
  -- to the same key.
  if public.plan_key('Google Workspace Business Standard')
     <> public.plan_key('Google Workspace Standard') then
    raise exception 'FAIL 1: Business Standard did not match Standard';
  end if;
  if public.plan_key('Google  Workspace   PLUS') <> 'google workspace plus' then
    raise exception 'FAIL 1: got %', public.plan_key('Google  Workspace   PLUS');
  end if;
  -- Punctuation, matching the TS: "(GCP)" and "&" become spaces, "Add-on" splits.
  if public.plan_key('Google Cloud Platform (GCP) Credits')
     <> 'google cloud platform gcp credits' then
    raise exception 'FAIL 1: punctuation, got %', public.plan_key('Google Cloud Platform (GCP) Credits');
  end if;
  if public.plan_key('Domain Registration & DNS') <> 'domain registration dns' then
    raise exception 'FAIL 1: ampersand';
  end if;
  if public.plan_key('Google Vault Add-on') <> 'google vault add on' then
    raise exception 'FAIL 1: hyphen';
  end if;
  -- Word ORDER must survive unnest -> string_agg. Without WITH ORDINALITY this is
  -- the assertion that would eventually fail on a bigger table.
  if public.plan_key('Microsoft 365 Apps for Business') <> 'microsoft 365 apps for' then
    raise exception 'FAIL 1: order/filler, got %', public.plan_key('Microsoft 365 Apps for Business');
  end if;
  -- Nothing in, nothing out — an unnamed plan must key to '' and match no item.
  if public.plan_key(null) <> '' or public.plan_key('   ') <> '' then
    raise exception 'FAIL 1: null/blank';
  end if;
  raise notice 'PASS 1: plan_key agrees with the TypeScript';
end $$;
rollback;

-- ── 2-7. The trigger ────────────────────────────────────────────────────────
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaa0248-0000-0000-0000-000000000001','ITEMID T1','t1@example.in','07','IT01'),
         ('aaaa0248-0000-0000-0000-000000000002','ITEMID T2','t2@example.in','07','IT02');
insert into public.customers (id, tenant_id, name)
  values ('cccc0248-0000-0000-0000-000000000001','aaaa0248-0000-0000-0000-000000000001','Cust One');

-- This tenant's catalog, shaped like the real one: the catalog says "Standard" while
-- the dialog writes "Business Standard"; ONE Enterprise row against three sold tiers;
-- and a hosting row also called "Standard".
insert into public.items (id, tenant_id, name, vendor, wholesale, msrp)
  values ('IT-STD-1','aaaa0248-0000-0000-0000-000000000001','Google Workspace Standard','google',620,864),
         ('IT-ENT-1','aaaa0248-0000-0000-0000-000000000001','Google Workspace Enterprise','google',2050,2400),
         ('IT-HST-1','aaaa0248-0000-0000-0000-000000000001','Standard','hosting',0,500);
-- Another tenant's item, for the tenant-safety check in 8.
insert into public.items (id, tenant_id, name, vendor, wholesale, msrp)
  values ('IT-OTHER-2','aaaa0248-0000-0000-0000-000000000002','Google Workspace Standard','google',999,1999);

do $$
declare v_item text; v_err boolean;
begin
  -- 2. The link an EXACT name match could never make.
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
    values ('bbbb0248-0000-0000-0000-000000000001','aaaa0248-0000-0000-0000-000000000001',
            'cccc0248-0000-0000-0000-000000000001','Cust One',
            'Google Workspace Business Standard','google',10,8640,'active');
  select item_id into v_item from public.subscriptions where id='bbbb0248-0000-0000-0000-000000000001';
  if v_item is distinct from 'IT-STD-1' then
    raise exception 'FAIL 2: expected IT-STD-1, got %', coalesce(v_item,'<null>');
  end if;
  raise notice 'PASS 2: "Business Standard" linked to the catalog''s "Standard"';

  -- 3. Three tiers, one Enterprise row → no guess.
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
    values ('bbbb0248-0000-0000-0000-000000000002','aaaa0248-0000-0000-0000-000000000001',
            'cccc0248-0000-0000-0000-000000000001','Cust One',
            'Google Workspace Enterprise Plus','google',5,12000,'active');
  select item_id into v_item from public.subscriptions where id='bbbb0248-0000-0000-0000-000000000002';
  if v_item is not null then
    raise exception 'FAIL 3: guessed % for Enterprise Plus', v_item;
  end if;
  raise notice 'PASS 3: Enterprise Plus left unlinked instead of guessed';

  -- 4. A Google plan literally named "Standard" must NOT take hosting's ₹0 row.
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
    values ('bbbb0248-0000-0000-0000-000000000003','aaaa0248-0000-0000-0000-000000000001',
            'cccc0248-0000-0000-0000-000000000001','Cust One','Standard','google',3,3000,'active');
  select item_id into v_item from public.subscriptions where id='bbbb0248-0000-0000-0000-000000000003';
  if v_item is not null then
    raise exception 'FAIL 4: cross-vendor link to %', v_item;
  end if;
  raise notice 'PASS 4: no cross-vendor link (no ₹0 cost on a Google seat)';

  -- 5. Two rows normalising to one key → decline, do not pick.
  insert into public.items (id, tenant_id, name, vendor, wholesale, msrp)
    values ('IT-STD-DUP','aaaa0248-0000-0000-0000-000000000001','Google Workspace Business Standard','google',700,900);
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status)
    values ('bbbb0248-0000-0000-0000-000000000004','aaaa0248-0000-0000-0000-000000000001',
            'cccc0248-0000-0000-0000-000000000001','Cust One',
            'Google Workspace Standard','google',2,1728,'active');
  select item_id into v_item from public.subscriptions where id='bbbb0248-0000-0000-0000-000000000004';
  if v_item is not null then
    raise exception 'FAIL 5: picked % out of two ambiguous rows', v_item;
  end if;
  raise notice 'PASS 5: ambiguous catalog → no link';
  delete from public.items where id='IT-STD-DUP';

  -- 6. An explicit item_id is never second-guessed, even when it disagrees with
  --    what the trigger would have chosen.
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, item_id)
    values ('bbbb0248-0000-0000-0000-000000000005','aaaa0248-0000-0000-0000-000000000001',
            'cccc0248-0000-0000-0000-000000000001','Cust One',
            'Google Workspace Business Standard','google',1,864,'active','IT-ENT-1');
  select item_id into v_item from public.subscriptions where id='bbbb0248-0000-0000-0000-000000000005';
  if v_item <> 'IT-ENT-1' then
    raise exception 'FAIL 6: overwrote an explicit item_id with %', v_item;
  end if;
  raise notice 'PASS 6: explicit item_id wins over the trigger';

  -- 7. Correcting a mis-typed plan re-points the link. Without this the cost stays
  --    attached to the wrong product with nothing on screen to say so.
  update public.subscriptions set item_id = null, plan = 'Google Workspace Enterprise'
    where id='bbbb0248-0000-0000-0000-000000000002';
  select item_id into v_item from public.subscriptions where id='bbbb0248-0000-0000-0000-000000000002';
  if v_item is distinct from 'IT-ENT-1' then
    raise exception 'FAIL 7: after correcting the plan, got %', coalesce(v_item,'<null>');
  end if;
  raise notice 'PASS 7: UPDATE re-resolves the link';

  -- 8. Tenant safety. The FK is composite on (tenant_id, item_id), so pointing at
  --    ANOTHER tenant's catalog row must be rejected — otherwise a cost read through
  --    this link would be another tenant's price.
  v_err := false;
  begin
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, item_id)
      values ('bbbb0248-0000-0000-0000-000000000006','aaaa0248-0000-0000-0000-000000000001',
              'cccc0248-0000-0000-0000-000000000001','Cust One','Whatever','google',1,100,'active','IT-OTHER-2');
  exception when foreign_key_violation then v_err := true;
  end;
  if not v_err then
    raise exception 'FAIL 8: accepted another tenant''s item_id';
  end if;
  raise notice 'PASS 8: cross-tenant item_id rejected by the FK';
end $$;

rollback;

-- ── 9. The real client path: role `authenticated`, RLS on ───────────────────
--
-- Runs against the LIVE ANUTECH DIGITAL tenant and its real catalog, because the
-- thing being tested is whether RLS + function grants let the trigger see `items`
-- at all — a synthetic tenant created as service_role would not prove that. Rolled
-- back, so nothing is left behind.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"3caa0f07-44d1-42ee-91b3-2123e04853b1","role":"authenticated"}', true);

do $$
declare v_item text; v_items int; v_expect text; v_plan text;
begin
  -- Sanity: can this user see its own catalog at all under RLS? If not, the link
  -- failure below would look like a matching bug instead of a permissions one.
  select count(*) into v_items from public.items;
  if v_items = 0 then
    raise exception 'FAIL 9: authenticated user sees 0 items — RLS or current_tenant_id() is the problem, not the matcher';
  end if;

  /* The catalog row is CHOSEN, not named.

     This block hardcoded plan 'Google Workspace Business Standard' expecting item
     'GW-STD-fbb', and on 29 Aug 2026 it failed with "got <null>". Nothing was broken:
     that row is simply not in the catalog any more, and this tenant's only active Google
     item today is Business Starter. The trigger declined because there was nothing to
     match — which is what it is supposed to do.

     A test that names a live catalog row goes red the day somebody edits the catalog, and
     a security-adjacent file that cries wolf gets discounted on the day it means
     something. So pick any active Google row whose plan_key is unique in this tenant, and
     assert the trigger links to THAT. Same thing proved — RLS + INVOKER rights let the
     trigger read `items` from a real client session — with nothing pinned to a row a
     human can delete. */
  select i.id, i.name into v_expect, v_plan
    from public.items i
   where i.vendor = 'google' and i.is_active
     and (select count(*) from public.items j
           where j.vendor = i.vendor and j.is_active
             and public.plan_key(j.name) = public.plan_key(i.name)) = 1
   order by i.id
   limit 1;
  if v_expect is null then
    raise exception 'FAIL 9: no unambiguous active Google item in this catalog, so the trigger has nothing it could link — add one, or this case cannot run';
  end if;

  insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr, status)
    values ('bbbb0248-9999-0000-0000-000000000009','fbb976f1-9090-4f10-9726-0901bd144e42',
            'RLS Probe', v_plan, 'google', 10, 8640, 'active');

  select item_id into v_item from public.subscriptions
   where id='bbbb0248-9999-0000-0000-000000000009';
  if v_item is distinct from v_expect then
    raise exception 'FAIL 9: as authenticated, plan % linked to % (expected %)',
      v_plan, coalesce(v_item,'<null>'), v_expect;
  end if;
  raise notice 'PASS 9: % linked to % as authenticated, through RLS', v_plan, v_item;
end $$;

rollback;
