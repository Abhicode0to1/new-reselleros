-- APPLIED to production on 2026-08-20. Kept as the record of what was run.
-- Pardeep's decision (Tree A of the four measured on 19 Aug):
--     Darshan (sales@anutech.in) -> Ananya (ananya@anutech.in)
--     Hitesh  (hitesh@anutech.in) -> Pardeep (pardeep@anutech.in)
-- Ananya -> Pardeep already existed and was left alone.
--
-- Re-running this is a no-op on the tree, but the lead-count assertions are dated: they
-- were true when 19 leads existed (Darshan 15 / Pardeep 3 / Hitesh 1). If a lead is added
-- or reassigned the numbers move and this file will (correctly) abort. To check the tree's
-- live effect instead, run verify-reporting-lines.sql, which writes nothing.
--
-- Tree A: Darshan -> Ananya, Hitesh -> Pardeep. Ananya -> Pardeep already exists.
-- Applies, then MEASURES the result through RLS from each person's seat. Any count that
-- differs from the 19-Aug measurement raises, aborting the transaction -- so a tree that
-- does not behave as predicted cannot commit.
begin;

update public.users set manager_id = '341840ec-bbc6-47c7-ab2e-adbc64b6d633'  -- Ananya
  where id = 'e67e30a6-3d9e-4348-a63a-feb7e1ef77f0';                          -- Darshan
update public.users set manager_id = '3caa0f07-44d1-42ee-91b3-2123e04853b1'  -- Pardeep
  where id = '611baca1-8c60-4cd8-8fd2-288822a3fef7';                          -- Hitesh

-- part 1: still the privileged connection -- did the writes survive the guard trigger,
-- and is the chain acyclic?
do $$
declare n integer;
begin
  select count(*) into n from public.users
    where id = 'e67e30a6-3d9e-4348-a63a-feb7e1ef77f0'
      and manager_id = '341840ec-bbc6-47c7-ab2e-adbc64b6d633';
  if n <> 1 then raise exception 'FAIL: Darshan manager_id did not stick'; end if;

  select count(*) into n from public.users
    where id = '611baca1-8c60-4cd8-8fd2-288822a3fef7'
      and manager_id = '3caa0f07-44d1-42ee-91b3-2123e04853b1';
  if n <> 1 then raise exception 'FAIL: Hitesh manager_id did not stick'; end if;

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

  raise notice 'writes landed, chain acyclic';
end $$;

-- part 2: RLS genuinely enforced from here on, exactly like a browser token
set local role authenticated;

do $$
declare
  v_pardeep uuid := '3caa0f07-44d1-42ee-91b3-2123e04853b1';
  v_ananya  uuid := '341840ec-bbc6-47c7-ab2e-adbc64b6d633';
  v_hitesh  uuid := '611baca1-8c60-4cd8-8fd2-288822a3fef7';
  v_darshan uuid := 'e67e30a6-3d9e-4348-a63a-feb7e1ef77f0';
  n integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ananya::text, 'role','authenticated')::text, true);
  if auth.uid() <> v_ananya then raise exception 'SETUP FAIL: impersonation did not take'; end if;
  select count(*) into n from public.leads;
  raise notice 'ananya sees % leads', n;
  if n <> 15 then raise exception 'FAIL: Ananya sees % leads, expected 15', n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_hitesh::text, 'role','authenticated')::text, true);
  select count(*) into n from public.leads;
  raise notice 'hitesh sees % leads', n;
  if n <> 1 then raise exception 'FAIL: Hitesh sees % leads, expected 1', n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_darshan::text, 'role','authenticated')::text, true);
  select count(*) into n from public.leads;
  raise notice 'darshan sees % leads', n;
  if n <> 15 then raise exception 'FAIL: Darshan sees % leads, expected 15', n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_pardeep::text, 'role','authenticated')::text, true);
  select count(*) into n from public.leads;
  raise notice 'pardeep sees % leads', n;
  if n <> 19 then raise exception 'FAIL: Pardeep sees % leads, expected 19', n; end if;

  raise notice 'TREE A APPLIED AND MEASURED';
end $$;

reset role;

select 'APPLIED' as tree_a;

commit;
