-- Read-only. Asserts what each person can actually see through RLS, from their own seat.
-- Writes nothing and ends in rollback, so it is safe against production at any time.
-- Run: cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked --        -f supabase/maintenance/verify-reporting-lines.sql
-- A green run prints one row: MEASURED-OK. Any drift raises with the person and both counts.
-- The expected numbers below are the 20 Aug 2026 measurement (19 ANUTECH leads); update
-- them deliberately, with a note, when the book changes -- never to make a red run go green.
--
-- read-only, fresh connection: asserts the COMMITTED tree's visibility. Ends in rollback.
begin;
set local role authenticated;
do $$
declare
  expected constant jsonb := jsonb_build_object(
    'pardeep@anutech.in', 19,   -- owner: whole pipeline
    'deepak@anutech.in',  19,   -- second owner: unchanged by the tree
    'ananya@anutech.in',  15,   -- was 0 -- now sees Darshan's book
    'hitesh@anutech.in',   1,   -- own lead only: no reports under him
    'sales@anutech.in',   15,   -- own book, unchanged
    'pratik@anutech.in',  19    -- support: role is not restricted (a decision, not a bug)
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
select 'MEASURED-OK' as committed_tree_visibility;
rollback;
