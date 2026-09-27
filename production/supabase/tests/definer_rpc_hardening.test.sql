-- Regression test: definer RPC hardening (migration 20260927100000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/definer_rpc_hardening.test.sql
--
-- What it proves:
--   1. A signed-in user with no `users` row cannot insert one for themselves (owner of any tenant).
--   2. That same user cannot run a tenant-guarded RPC (update_project_details) — it raises
--      instead of silently skipping the check.
--   3. anon cannot EXECUTE money RPCs at all (refund_payment, reopen_quote,
--      reconcile_bank_txn, resolve_or_create_contact).
--   4. No SECURITY DEFINER function in public still has the weak `is not null and` guard.
--   5. Functions used by RLS policies stay callable by authenticated (current_tenant_id,
--      can_see_record) — the grant sweep must not touch them.
--   6. A real team member can still run the RPC against their own tenant's data (the
--      rewrite did not break the happy path).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000e5', 'HARDEN A', 'hd-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e5a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hd-member@example.in'),
  ('cccccccc-0000-0000-0000-00000000e5c5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hd-stranger@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000e5a5', 'aaaaaaaa-0000-0000-0000-0000000000e5', 'hd-member@example.in', 'owner');
insert into public.project_sales (id, tenant_id, customer_name, title, taxable_amount, gst_amount, total_amount, status, gst_rate)
values ('aaaaaaaa-0000-0000-0000-00000000e5e5', 'aaaaaaaa-0000-0000-0000-0000000000e5', 'Cust', 'Proj', 100000, 18000, 118000, 'quoted', 18);

-- 4. Nothing weak survives
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.prosecdef
                and pg_get_functiondef(p.oid) ~* 'if v_tenant is not null and ') then
    raise exception 'FAIL 4: a weak tenant guard remains';
  end if;
end $$;

-- 3 + 5. anon
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
do $$
declare fn text;
begin
  foreach fn in array array['refund_payment', 'reopen_quote', 'reconcile_bank_txn', 'resolve_or_create_contact', 'update_project_details'] loop
    if has_function_privilege('anon', (select oid from pg_proc where proname = fn limit 1), 'EXECUTE') then
      raise exception 'FAIL 3: anon can execute %', fn;
    end if;
  end loop;
  /* 5. The policy helpers stay callable by the roles that run queries under RLS. anon never
     had current_tenant_id (checked before this migration); authenticated must keep it. */
  if not has_function_privilege('authenticated', 'public.current_tenant_id()', 'EXECUTE') then
    raise exception 'FAIL 5: authenticated lost current_tenant_id';
  end if;
  if not has_function_privilege('authenticated', 'public.can_see_record(uuid)', 'EXECUTE') then
    raise exception 'FAIL 5: authenticated lost can_see_record';
  end if;
end $$;

-- 1 + 2. Signed in, no users row (the "stranger")
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-00000000e5c5', 'role', 'authenticated')::text, true);
do $$ begin
  begin
    insert into public.users (id, tenant_id, email, role)
    values ('cccccccc-0000-0000-0000-00000000e5c5', 'aaaaaaaa-0000-0000-0000-0000000000e5', 'hd-stranger@example.in', 'owner');
    raise exception 'FAIL 1: a stranger made themselves owner';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_project_details('aaaaaaaa-0000-0000-0000-00000000e5e5', 'Hacked', null, null, 'Cust', 118000, 18, false, '[{"label":"Full","total_amount":118000}]'::jsonb);
    raise exception 'FAIL 2: a stranger updated a project';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;   -- any other error is the guard firing
  end;
end $$;

-- 6. A real member still can
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000e5a5', 'role', 'authenticated')::text, true);
do $$
declare t text;
begin
  perform public.update_project_details('aaaaaaaa-0000-0000-0000-00000000e5e5', 'Renamed', null, null, 'Cust', 118000, 18, false, '[{"label":"Full","total_amount":118000}]'::jsonb);
  select title into t from public.project_sales where id = 'aaaaaaaa-0000-0000-0000-00000000e5e5';
  if t is distinct from 'Renamed' then raise exception 'FAIL 6: member could not update own project (%)', t; end if;
end $$;

select 'definer_rpc_hardening: all assertions passed' as result;
rollback;
