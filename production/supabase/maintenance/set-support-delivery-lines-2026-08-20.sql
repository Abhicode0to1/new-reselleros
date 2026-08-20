-- APPLIED to production on 2026-08-20. Pardeep's call: all four support/delivery people
-- report to Hitesh Baghel (hitesh@anutech.in, manager).
--
-- This changes the ORG CHART ONLY, and the assertions below are what prove that claim.
-- Nobody's lead visibility moves: the four own zero leads, and support/delivery are not
-- restricted roles to begin with (the restriction covers sales, sales_senior, manager).
-- So Hitesh gains 4 direct reports and still sees exactly 1 lead -- his own.
--
-- Read-only re-check any time: verify-reporting-lines.sql
begin;

update public.users set manager_id = '611baca1-8c60-4cd8-8fd2-288822a3fef7'  -- Hitesh
where email in ('pratik@anutech.in','ranjeet@anutech.in',
                'pawan@anutech.in','abhishek@anutech.in')
  and tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

do $$
declare n integer;
begin
  select count(*) into n from public.users
  where manager_id = '611baca1-8c60-4cd8-8fd2-288822a3fef7';
  if n <> 4 then raise exception 'FAIL: Hitesh has % direct reports, expected 4', n; end if;

  -- every ANUTECH user now has a manager except the three owners
  select count(*) into n from public.users
  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42' and manager_id is null;
  if n <> 3 then raise exception 'FAIL: % users without a manager, expected 3 (the owners)', n; end if;

  with recursive chain as (
    select id as start_id, manager_id, 1 as depth
      from public.users where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
    union all
    select c.start_id, u.manager_id, c.depth + 1
      from chain c join public.users u on u.id = c.manager_id
      where c.depth < 12
  )
  select count(*) into n from chain where manager_id = start_id;
  if n <> 0 then raise exception 'FAIL: manager chain has a cycle'; end if;
end $$;

-- ⚠ CORRECTED 20 Aug 2026, the same day, and the correction matters more than the change.
-- As originally run, the visibility block below drove its loop off `select ... from
-- public.users` AFTER the role switch. As `authenticated` with no JWT yet there is no
-- auth.uid(), RLS hides every row, so the loop ran ZERO times and the file committed
-- reporting nine assertions it never evaluated. The org-chart half (direct reports, no
-- cycle, three rootless owners) DID run -- that block is above the role switch, on the
-- privileged connection -- so the tree itself was always proven. What was not proven was
-- the claim this file exists to make: that nobody's visibility moved.
--
-- Fixed the same way as verify-reporting-lines.sql: read the roster BEFORE dropping to
-- `authenticated`, and count the loop's own iterations so measuring nobody fails instead
-- of passing. Re-verified afterwards -- and the numbers were right all along; only the
-- evidence was missing.
do $$
declare roster jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', id, 'email', email) order by email)
    into roster from public.users
    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
  if roster is null then raise exception 'no users in the tenant -- wrong tenant id?'; end if;
  perform set_config('org.roster', roster::text, true);
end $$;

set local role authenticated;

do $$
declare
  -- the whole point: the org chart moved, the numbers did not
  expected constant jsonb := jsonb_build_object(
    'pardeep@anutech.in',  19,
    'deepak@anutech.in',   19,
    'ananya@anutech.in',   15,
    'hitesh@anutech.in',    1,   -- 4 reports now, still 1 lead: they own none
    'sales@anutech.in',    15,
    'pratik@anutech.in',   19,
    'ranjeet@anutech.in',  19,
    'pawan@anutech.in',    19,
    'abhishek@anutech.in', 19
  );
  roster jsonb := current_setting('org.roster')::jsonb;
  item jsonb; n integer; want integer; iterated integer := 0;
begin
  for item in select value from jsonb_array_elements(roster) loop
    if not (expected ? (item->>'email')) then continue; end if;   -- e.g. the third owner
    perform set_config('request.jwt.claims',
      json_build_object('sub', item->>'id', 'role','authenticated')::text, true);
    if auth.uid()::text <> (item->>'id') then
      raise exception 'SETUP FAIL for %', item->>'email';
    end if;
    select count(*) into n from public.leads;
    want := (expected ->> (item->>'email'))::int;
    if n <> want then
      raise exception 'MISMATCH: % sees % leads, expected %', item->>'email', n, want;
    end if;
    iterated := iterated + 1;
  end loop;
  if iterated <> (select count(*) from jsonb_object_keys(expected)) then
    raise exception 'VACUOUS RUN: measured % of % people -- an empty loop must not pass',
      iterated, (select count(*) from jsonb_object_keys(expected));
  end if;
end $$;

reset role;
select 'APPLIED' as support_delivery_lines;
commit;
