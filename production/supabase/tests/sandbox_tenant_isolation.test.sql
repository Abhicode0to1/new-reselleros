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
-- SAFETY: every row this file touches is synthetic and created here, in one transaction
-- that ends in ROLLBACK. No live row is read into an assertion or written.
--
-- HERMETIC AS OF 11 SEP 2026, AND IT WAS NOT BEFORE. This header used to say "synthetic
-- identity in the EXISTING sandbox tenant", and case 4 authenticated as a real employee's
-- account inside the real buy-page tenant. Both are now created in the reserved
-- `7e57e57e-` fixture namespace (hex-leet for TESTEST), because a test that only runs
-- where somebody once created a row by hand is a test nobody can be sure has run — and
-- against a database built from `supabase/migrations` this one died on a foreign key
-- before asserting anything at all.
begin;

/* The sandbox tenant this file works in.
 *
 * This USED to say "synthetic identity in the existing sandbox tenant" and
 * insert nothing — it relied on a ZZ TESTING SANDBOX row that happens to exist
 * in production. Against a database built from `supabase/migrations` that row is
 * absent, so the file died on a foreign key before asserting anything:
 *
 *     Key (tenant_id)=(7e57e57e-0000-4000-8000-000000000001)
 *     is not present in table "tenants"
 *
 * A test that only runs where somebody once created a row by hand is a test that
 * cannot be trusted to have run. `7e57e57e-` is the reserved fixture namespace
 * (hex-leet for TESTEST) and this file owns the -0000- block, so it creates what
 * it needs and the ROLLBACK below takes it away again.
 *
 * ON CONFLICT because on production the row is already there and this must not
 * fight it. Nothing below asserts anything about the tenant's own columns — it is
 * a container for the user and the catalog row this file creates — so adopting an
 * existing row cannot make an assertion pass for the wrong reason. */
insert into public.tenants (id, name, email, doc_code, tier) values
  ('7e57e57e-0000-4000-8000-000000000001', 'ZZ TESTING SANDBOX',
   'zz-sandbox@example.invalid', 'ZZSBX', 'reseller')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('5a5a5a5a-0000-4000-8000-00000000000b', 'sandbox-tester@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('5a5a5a5a-0000-4000-8000-00000000000b',
   '7e57e57e-0000-4000-8000-000000000001',            -- ZZ TESTING SANDBOX
   'sandbox-tester@example.test', 'Sandbox Tester', 'owner', true);

/* One catalog row for the sandbox, so case 2 below has something it SHOULD see.

   Case 2 is the control: it reads a table the tester is entitled to and fails if the
   answer is empty, because otherwise case 1's zeros could mean "the wall holds" or "this
   session is dead" and the file could not tell them apart.

   On 29 Aug 2026 the control itself went red — "the tester sees NO items at all". The
   session was fine. The sandbox tenant simply has an empty catalog (0 items; the live
   tenant has 1). So the control was resting on a row nobody had promised to keep, and it
   would have gone red again on the day anyone cleared the catalog.

   Creating the row here fixes that at the root: it exists for exactly this transaction,
   the tester's own tenant owns it, and it is gone at rollback. Inserted BEFORE the role
   switch, so it is setup and not part of what is being measured. */
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('5a5a5a5a-sandbox-control-item', '7e57e57e-0000-4000-8000-000000000001',
   'Sandbox Control Item', 'google', 100, 50);

/* THE LIVE SIDE OF THE WALL, created here for the same reason — and this is the
   half the 29 Aug fix missed.
   
   Case 4 ("the wall is two-way") used to authenticate as a REAL PERSON'S account,
   `3caa0f07-…` — Pardeep's own user — inside the real buy-page tenant
   `fbb976f1-…`, and assert that they could still see their own catalogue. Two
   things wrong with that, and only one of them shows up as a failure:

     · on any database built from `supabase/migrations` neither row exists, so
       the session resolved to nobody and the control went red — "the live owner
       sees no items at all";
     · and where it DID pass, it passed because of one particular employee's
       account and one tenant's catalogue, neither of which the file created or
       anyone promised to keep. That is the exact fragility the comment above
       says it fixed "at the root" — fixed for the sandbox side, left standing on
       the live side.

   So the live side is synthetic too now: its own reserved tenant, its own owner,
   its own single item. Case 4 asserts the same thing it always did — a
   non-sandbox owner sees no sandbox rows and still sees their own — without
   depending on who happens to work here. */
insert into public.tenants (id, name, email, doc_code, tier) values
  ('7e57e57e-0000-4000-8000-000000000002', 'ZZ TESTING LIVE-SIDE',
   'zz-liveside@example.invalid', 'ZZLIV', 'reseller')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('5a5a5a5a-0000-4000-8000-00000000000c', 'liveside-owner@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('5a5a5a5a-0000-4000-8000-00000000000c',
   '7e57e57e-0000-4000-8000-000000000002',
   'liveside-owner@example.test', 'Live-side Owner', 'owner', true);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('5a5a5a5a-liveside-ctrl-item', '7e57e57e-0000-4000-8000-000000000002',
   'Live-side Control Item', 'google', 200, 100);

-- `authenticated` is the role a real browser token arrives as, so RLS is genuinely
-- enforced from here on. A superuser connection bypasses RLS and would prove nothing.
set local role authenticated;

do $$
declare
  v_tester  uuid := '5a5a5a5a-0000-4000-8000-00000000000b';
  /* Synthetic, in the reserved 7e57e57e- fixture namespace — NOT a real employee
     and not the real buy-page tenant. See the fixture block above. */
  v_liveowner uuid := '5a5a5a5a-0000-4000-8000-00000000000c';
  v_live      uuid := '7e57e57e-0000-4000-8000-000000000002';
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

  --------------------------------------- 1. THE HEADLINE: none of ANOTHER tenant's business
  /* Every count here is scoped `tenant_id <> v_sandbox`, and that scoping is the whole
     assertion — not tidiness.

     These were bare `count(*)` until 22 Aug 2026, which was correct only for as long as the
     sandbox stayed empty. The day the tester created their 8th customer the test announced
     "a sandbox tester can read 8 customer(s) of the live business" — counting the tester's
     OWN rows and naming them somebody else's. Nothing had leaked: the tester saw 8, the
     sandbox owned 8, and the live tenant's 26 were not among them.

     A security test that cries wolf is worse than no test, because the next reader learns to
     discount it and then disbelieves it on the day it means something. The `users` line
     below was already scoped, and case 2 already scopes `items` — so this is the file's own
     idiom, applied to the seven lines that were missed.

     `<> v_sandbox` rather than `= v_live` on purpose: there is a third tenant (Excel
     Technologies), and "not mine" catches a leak from any of them, not just the big one. */
  select count(*) into n from public.customers where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % customer(s) belonging to another tenant', n; end if;

  select count(*) into n from public.quotes where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % quote(s) belonging to another tenant', n; end if;

  select count(*) into n from public.invoices where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % invoice(s) of another tenant — these are GST documents', n; end if;

  select count(*) into n from public.payments where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % payment(s) belonging to another tenant', n; end if;

  select count(*) into n from public.subscriptions where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % subscription(s) belonging to another tenant', n; end if;

  select count(*) into n from public.leads where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % lead(s) belonging to another tenant', n; end if;

  select count(*) into n from public.expenses where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % expense(s) belonging to another tenant', n; end if;

  select count(*) into n from public.users where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 1: a sandbox tester can read % teammate row(s) of another tenant', n; end if;

  ---------------------- 2. THE CONTROL: the same session CAN read what it should
  -- Without this, every zero above could be a broken session rather than a wall.
  select count(*) into n from public.items;
  if n = 0 then
    raise exception 'FAIL 2: the tester cannot see even the catalog row this test just created for their own tenant — this session is blocked outright, so the zeros above prove nothing about tenant isolation';
  end if;
  select count(*) into n from public.items where tenant_id <> v_sandbox;
  if n <> 0 then raise exception 'FAIL 2: the tester sees % item(s) belonging to another tenant', n; end if;

  /* At LEAST one, not exactly one. This said `<> 1` and broke on 22 Aug 2026 with "sees 2
     user rows, expected 1" — the synthetic owner this file creates plus the real tester who
     signed up into the sandbox on 21 Aug. Both belong there.

     Pinning the number added nothing: "only my own tenant" is already proved in case 1
     (`users where tenant_id <> v_sandbox` = 0). All this control has to establish is that
     the session is not blocked outright, so that case 1's zeros mean a wall and not a dead
     session. An exact count here just re-breaks the test every time the sandbox gains a
     legitimate teammate — the same brittleness case 1 was fixed for. */
  select count(*) into n from public.users;   -- their own tenant's roster
  if n < 1 then raise exception 'FAIL 2: the tester sees no user rows at all, not even their own — this session is blocked, so the zeros above prove nothing'; end if;

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
    json_build_object('sub', v_liveowner::text, 'role', 'authenticated')::text, true);

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
