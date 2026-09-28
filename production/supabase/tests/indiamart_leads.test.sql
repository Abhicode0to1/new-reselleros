-- Regression test: S34 IndiaMART lead pull (migration 20260928151000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/indiamart_leads.test.sql
--
-- What it proves:
--   1. import_indiamart_lead creates ONE lead (source 'indiamart', stage 'new') per IndiaMART
--      query id; the same query id again returns NULL and creates nothing.
--   2. The same query id for a DIFFERENT company is that company's own lead.
--   3. A signed-in user cannot call the function, cannot write the import/sync tables, and
--      sees only their own company's rows.
--   4. anon has no access.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000034a1', 'IM TEST A', 'im-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000034b1', 'IM TEST B', 'im-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000034a0a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'im-a-owner@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000034b0b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'im-b-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000034a0a1', 'aaaaaaaa-0000-0000-0000-0000000034a1', 'im-a-owner@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000034b0b1', 'bbbbbbbb-0000-0000-0000-0000000034b1', 'im-b-owner@example.in', 'owner');

-- ── 1 + 2 as the server ────────────────────────────────────────────────────
do $$
declare r1 text; r2 text; r3 text; n int; src text; stg text; co text;
begin
  r1 := public.import_indiamart_lead('aaaaaaaa-0000-0000-0000-0000000034a1', '2451111111', 'L-IMTEST-A1',
          'Sharma Traders', 'Rakesh Sharma', 'rakesh@example.in', '+919811111111', 'Delhi',
          'IndiaMART: Google Workspace for 10 users', '2026-09-28 10:15:00+05:30', 'W');
  r2 := public.import_indiamart_lead('aaaaaaaa-0000-0000-0000-0000000034a1', '2451111111', 'L-IMTEST-A1-DUP',
          'Sharma Traders', 'Rakesh Sharma', null, '+919811111111', 'Delhi', 'again', null, 'W');
  if r1 is distinct from 'L-IMTEST-A1' then raise exception 'FAIL 1a: first import returned %', r1; end if;
  if r2 is not null then raise exception 'FAIL 1b: the same query id imported twice (%)', r2; end if;

  select count(*) into n from public.leads where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000034a1';
  if n <> 1 then raise exception 'FAIL 1c: % leads for one IndiaMART enquiry', n; end if;
  select source, stage::text, company into src, stg, co from public.leads where id = 'L-IMTEST-A1';
  if src <> 'indiamart' or stg <> 'new' or co <> 'Sharma Traders' then
    raise exception 'FAIL 1d: lead saved as source %, stage %, company %', src, stg, co;
  end if;
  select count(*) into n from public.indiamart_lead_imports where lead_id = 'L-IMTEST-A1';
  if n <> 1 then raise exception 'FAIL 1e: import row not linked to the lead'; end if;

  -- blank company falls back to the person, not to an empty NOT NULL
  r3 := public.import_indiamart_lead('aaaaaaaa-0000-0000-0000-0000000034a1', '2452222222', 'L-IMTEST-A2',
          '  ', 'Priya', null, null, null, null, null, null);
  select company into co from public.leads where id = 'L-IMTEST-A2';
  if co <> 'Priya' then raise exception 'FAIL 1f: blank company saved as %', co; end if;

  -- 2. same query id, other company
  r3 := public.import_indiamart_lead('bbbbbbbb-0000-0000-0000-0000000034b1', '2451111111', 'L-IMTEST-B1',
          'Sharma Traders', 'Rakesh Sharma', null, '+919811111111', null, null, null, null);
  if r3 is distinct from 'L-IMTEST-B1' then raise exception 'FAIL 2: company B could not import its own copy (%)', r3; end if;

  insert into public.indiamart_sync_state (tenant_id, last_end_at, last_ok)
  values ('aaaaaaaa-0000-0000-0000-0000000034a1', now(), true);
end $$;

-- ── 3. as a signed-in user of company B ────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000034b0b1', 'role', 'authenticated')::text, true);
do $$
declare n int; r text;
begin
  select count(*) into n from public.indiamart_lead_imports;
  if n <> 1 then raise exception 'FAIL 3a: company B sees % import rows (expected only its own 1)', n; end if;
  select count(*) into n from public.indiamart_sync_state;
  if n <> 0 then raise exception 'FAIL 3b: company B sees company A''s sync state'; end if;

  begin
    r := public.import_indiamart_lead('bbbbbbbb-0000-0000-0000-0000000034b1', '999', 'L-IMTEST-HACK',
           'x', null, null, null, null, null, null, null);
    raise exception 'FAIL 3c: a browser user could call import_indiamart_lead';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.indiamart_lead_imports (tenant_id, query_id) values ('bbbbbbbb-0000-0000-0000-0000000034b1', 'fake');
    raise exception 'FAIL 3d: a browser user wrote an import row (would block a real enquiry)';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
do $$
declare n int;
begin
  -- precondition for 3a/3b's zeros (L7): A's rows exist
  select count(*) into n from public.indiamart_lead_imports where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000034a1';
  if n <> 2 then raise exception 'FAIL 3e: precondition — A has % import rows', n; end if;
  if has_table_privilege('anon', 'public.indiamart_lead_imports', 'select')
     or has_table_privilege('anon', 'public.indiamart_sync_state', 'select') then
    raise exception 'FAIL 4a: anon can read IndiaMART tables';
  end if;
  if has_function_privilege('anon', 'public.import_indiamart_lead(uuid, text, text, text, text, text, text, text, text, timestamptz, text)', 'execute') then
    raise exception 'FAIL 4b: anon can execute import_indiamart_lead';
  end if;
end $$;

select 'indiamart_leads: all assertions passed' as result;
rollback;
