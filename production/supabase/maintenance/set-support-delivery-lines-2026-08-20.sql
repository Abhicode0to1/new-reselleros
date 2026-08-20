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
  r record; n integer; want integer;
begin
  for r in select id, email from public.users
           where email in (select jsonb_object_keys(expected)) order by email
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.id::text, 'role','authenticated')::text, true);
    if auth.uid() <> r.id then raise exception 'SETUP FAIL for %', r.email; end if;
    select count(*) into n from public.leads;
    want := (expected ->> r.email)::int;
    if n <> want then
      raise exception 'MISMATCH: % sees % leads, expected %', r.email, n, want;
    end if;
  end loop;
end $$;

reset role;
select 'APPLIED' as support_delivery_lines;
commit;
