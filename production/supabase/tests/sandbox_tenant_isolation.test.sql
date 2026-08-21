-- Regression test for the testing sandbox tenant (supabase/maintenance/create-test-tenant.sql)
--
-- WHAT THIS PROVES, AND WHY IT COULD NOT WAIT
--   Testers were about to be pointed at a sandbox tenant on the PRODUCTION database,
--   on the strength of "RLS is tenant-scoped everywhere". That sentence is true and it
--   is still not evidence: the live tenant holds 14 customers, 21 invoices and 23
--   payments, the plan has no PITR, and the first person to find a hole in the wall
--   would be a tester who does not know a hole is possible.
--
--   So the wall is measured here instead of asserted in a comment. And it is measured
--   WITHOUT waiting for the tester to sign up — a synthetic sandbox member is created
--   inside a transaction, sat in, and rolled back.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. A sandbox owner sees ZERO of the live tenant's money.        ← the headline
--   2. A sandbox owner DOES see the sandbox's own item catalogue.   ← not over-blocked
--   3. A sandbox owner cannot write into the live tenant.           ← with_check
--   4. A live-tenant owner sees ZERO sandbox rows.                  ← the wall is two-way
--   5. The sandbox owner's private vault is empty and their own.    ← auth.uid() scope
--
-- WHY CASE 2 IS NOT FILLER
--   Every count in case 1 is expected to be zero, and zero is what a broken query
--   returns too. If RLS were denying this session everything — wrong role, missing
--   claim, a typo in the tenant id — case 1 would pass for the wrong reason and keep
--   passing after the wall came down. Case 2 is the control: the same session, the
--   same role, reading rows it SHOULD see. Without it this file proves nothing.
--
-- SAFETY: synthetic identity in the existing sandbox tenant, one transaction, ends in
-- ROLLBACK. No live row is read into an assertion or written.
begin;

insert into auth.users (id, email) values
  ('5a5a5a5a-0000-4000-8000-00000000000b', 'sandbox-tester@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('5a5a5a5a-0000-4000-8000-00000000000b',
   '7e57e57e-0000-4000-8000-000000000001',            -- ZZ TESTING SANDBOX
   'sandbox-tester@example.test', 'Sandbox Tester', 'owner', true);

-- `authenticated` is the role a real browser token arrives as, so RLS is genuinely
-- enforced from here on. A superuser connection bypasses RLS and would prove nothing.
set local role authenticated;

do $$
declare
  v_tester  uuid := '5a5a5a5a-0000-4000-8000-00000000000b';
  v_pardeep uuid := '3caa0f07-44d1-42ee-91b3-2123e04853b1';
  v_live    uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  v_sandbox uuid := '7e57e57e-0000-4000-8000-000000000001';
  n         integer;
  v_blocked boolean;
  v_msg     text;
begin
  ------------------------------------------------------------------ become the tester
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_tester::text, 'role', 'authenticated')::text, true);
  if auth.uid() <> v_tester then
    raise exception 'SETUP FAIL: auth.uid() is % — the impersonation did not take', auth.uid();
  end if;

  --------------------------------------- 1. THE HEADLINE: none of the real business
  select count(*) into n from public.customers;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % customer(s) of the live business', n; end if;

  select count(*) into n from public.quotes;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % quote(s)', n; end if;

  select count(*) into n from public.invoices;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % invoice(s) — these are GST documents', n; end if;

  select count(*) into n from public.payments;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % payment(s)', n; end if;

  select count(*) into n from public.subscriptions;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % subscription(s)', n; end if;

  select count(*) into n from public.leads;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % lead(s)', n; end if;

  select count(*) into n from public.expenses;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % expense(s)', n; end if;

  select count(*) into n from public.users where tenant_id = v_live;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % live teammate row(s)', n; end if;

  ---------------------- 2. THE CONTROL: the same session CAN read what it should
  -- Without this, every zero above could be a broken session rather than a wall.
  select count(*) into n from public.items;
  if n = 0 then
    raise exception 'FAIL 2: the tester sees NO items at all — this session is blocked outright, so the zeros above prove nothing about tenant isolation';
  end if;
  select count(*) into n from public.items where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 2: the tester sees % item(s) belonging to another tenant', n; end if;

  select count(*) into n from public.users;   -- their own tenant's roster
  if n <> 1 then raise exception 'FAIL 2: the tester sees % user rows in their own tenant, expected 1', n; end if;

  ------------------------------------- 3. cannot plant a row in the live tenant
  v_blocked := false;
  begin
    -- `customers` has no `email` column (it is `contact_email`). The first version of
    -- this test used `email`, the insert failed on the missing column, and case 3's
    -- second assertion refused to call that an RLS block. Worth keeping in mind: a
    -- "cannot insert" test passes for free if the insert was never valid to begin with.
    insert into public.customers (tenant_id, name, contact_email)
      values (v_live, 'planted by the sandbox tester', 'planted@example.test');
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'FAIL 3: a sandbox tester inserted a customer into the LIVE tenant';
  end if;
  /* Measured, not assumed: the block actually comes from the document-numbering
     trigger ("Cannot allocate a customer number for another tenant"), which fires
     BEFORE the RLS with_check gets a word in. Two independent walls, and the outer one
     has the better message. So either is accepted — but only those two. Matching on
     "was there any error" is what let a missing-column typo pass as a security pass one
     revision ago. */
  if v_msg not like '%row-level security%'
     and v_msg not like '%another tenant%' then
    raise exception 'FAIL 3: blocked, but not by a tenant guard: %', v_msg;
  end if;

  ------------------------------------- 4. the wall is two-way
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_pardeep::text, 'role', 'authenticated')::text, true);

  select count(*) into n from public.items where tenant_id = v_sandbox;
  if n <> 0 then raise exception 'FAIL 4: the live owner can see % sandbox item(s) — test data would pollute real reports', n; end if;

  select count(*) into n from public.users where tenant_id = v_sandbox;
  if n <> 0 then raise exception 'FAIL 4: the live owner can see % sandbox user(s)', n; end if;

  -- and the live owner still sees their own catalogue (control again)
  select count(*) into n from public.items;
  if n = 0 then raise exception 'FAIL 4: the live owner sees no items at all — session is broken, not isolated'; end if;

  ------------------------------------- 5. the private vault is per-person, not per-role
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_tester::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_accounts;
  if n <> 0 then raise exception 'FAIL 5: a sandbox owner can read % personal account row(s)', n; end if;
  select count(*) into n from public.personal_holdings;
  if n <> 0 then raise exception 'FAIL 5: a sandbox owner can read % personal holding(s)', n; end if;

  raise notice 'PASS — all 5 cases';
end $$;

reset role;

-- Single visible result, so a green run is unmistakable.
select 'PASS' as sandbox_tenant_isolation;

rollback;
