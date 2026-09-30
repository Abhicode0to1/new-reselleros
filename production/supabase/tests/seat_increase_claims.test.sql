-- Regression test: the add-seats idempotency claim (R-060).
-- Migration 20260930150000_seat_increase_claims.sql. Rolled back — safe on production.
--
--   BLOCKED  a second claim with the same (tenant, key)  ← this IS the idempotency
--   ALLOWED  the same key in a DIFFERENT tenant
--   BLOCKED  an authenticated session INSERTing a claim
--   BLOCKED  an authenticated session READING another tenant's claim
--   ALLOWED  that session reading its OWN tenant's claim
--
-- The last ALLOWED matters as much as the blocks. A read policy that also hid the
-- operator's own claims would make the replay path untraceable from the UI, and the
-- first person to debug a "these seats are already being added" message would switch
-- the policy off (L103).
--
-- The unique index is the whole mechanism, so it is asserted directly rather than
-- through the route: a route test can only show that today's code calls the insert,
-- while this shows the database would refuse the second write even if it did not.
--
-- Fixture owns its data (L11). Ids read before the role switch, carried in the JWT (L14).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('60600000-0000-4000-8000-000000000001', 'R060 TEST A', 'r060a@example.in', '07', 'R60A'),
  ('60600000-0000-4000-8000-000000000002', 'R060 TEST B', 'r060b@example.in', '07', 'R60B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('60600000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r060-a@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('60600000-0000-4000-8000-00000000000a', '60600000-0000-4000-8000-000000000001', 'r060-a@example.in', 'owner', true);

insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr) values
  ('60600000-0000-4000-8000-0000000000f1'::uuid, '60600000-0000-4000-8000-000000000001', 'Cust A', 'Business Standard', 'google', 10, 6200),
  ('60600000-0000-4000-8000-0000000000f2'::uuid, '60600000-0000-4000-8000-000000000002', 'Cust B', 'Business Standard', 'google', 10, 6200);

do $$
declare v_err boolean; v_n int; v_msg text;
begin
  -- ── The first claim goes in ───────────────────────────────────────────────
  insert into public.seat_increase_claims (tenant_id, subscription_id, idempotency_key, additional_seats)
  values ('60600000-0000-4000-8000-000000000001', '60600000-0000-4000-8000-0000000000f1',
          'intent-aaaaaaaa-1111', 5);

  -- ── BLOCKED: the same key again, which is the double POST ────────────────
  v_err := false;
  begin
    insert into public.seat_increase_claims (tenant_id, subscription_id, idempotency_key, additional_seats)
    values ('60600000-0000-4000-8000-000000000001', '60600000-0000-4000-8000-0000000000f1',
            'intent-aaaaaaaa-1111', 5);
  exception when unique_violation then v_err := true; end;
  if not v_err then
    raise exception 'FAIL 1: the same idempotency key was claimed twice — a double POST would add the seats and raise the quote again';
  end if;

  /* The seat count is deliberately DIFFERENT here. A replay is decided by the key
     alone; if the constraint had included additional_seats, a double-click that
     somehow carried a different count would have slipped through, and "the key
     identifies one intent" would not be true. */
  v_err := false;
  begin
    insert into public.seat_increase_claims (tenant_id, subscription_id, idempotency_key, additional_seats)
    values ('60600000-0000-4000-8000-000000000001', '60600000-0000-4000-8000-0000000000f1',
            'intent-aaaaaaaa-1111', 9);
  exception when unique_violation then v_err := true; end;
  if not v_err then
    raise exception 'FAIL 2: the key stopped identifying the intent — a replay with a different seat count was accepted';
  end if;

  -- ── ALLOWED: the same key in another tenant ──────────────────────────────
  /* Keys are chosen by clients. Without the tenant in the index, one tenant could
     block another's seat change by claiming a fixed string first. */
  insert into public.seat_increase_claims (tenant_id, subscription_id, idempotency_key, additional_seats)
  values ('60600000-0000-4000-8000-000000000002', '60600000-0000-4000-8000-0000000000f2',
          'intent-aaaaaaaa-1111', 5);

  select count(*) into v_n from public.seat_increase_claims where idempotency_key = 'intent-aaaaaaaa-1111';
  if v_n <> 2 then raise exception 'FAIL 3: expected one claim per tenant, found %', v_n; end if;

  -- ── The browser side ─────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub','60600000-0000-4000-8000-00000000000a','role','authenticated')::text, true);

  -- BLOCKED: writing a claim. There is no legitimate reason for a session to do this,
  -- and one that could would be able to suppress a real seat increase by claiming its
  -- key first.
  v_err := false;
  begin
    insert into public.seat_increase_claims (tenant_id, subscription_id, idempotency_key, additional_seats)
    values ('60600000-0000-4000-8000-000000000001', '60600000-0000-4000-8000-0000000000f1',
            'intent-forged-0001', 1);
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 4: a browser session wrote an idempotency claim — it could pre-claim a key and silently swallow a real seat increase';
  end if;

  -- BLOCKED: reading the other tenant's claim
  select count(*) into v_n from public.seat_increase_claims
   where tenant_id = '60600000-0000-4000-8000-000000000002';
  if v_n <> 0 then raise exception 'FAIL 5: % claim row(s) of another tenant were readable', v_n; end if;

  -- ALLOWED: reading its own
  select count(*) into v_n from public.seat_increase_claims
   where tenant_id = '60600000-0000-4000-8000-000000000001';
  if v_n <> 1 then
    raise exception 'FAIL 6: the operator cannot see their own claim (% rows) — the replay message would be untraceable and the policy would get switched off', v_n;
  end if;
  reset role;

  -- ── anon holds nothing ───────────────────────────────────────────────────
  select count(*) into v_n from information_schema.role_table_grants
   where table_name = 'seat_increase_claims' and grantee = 'anon';
  if v_n <> 0 then raise exception 'FAIL 7: anon holds % privilege(s) on seat_increase_claims', v_n; end if;

  /* authenticated holds SELECT and nothing else. Asserted because `create table` in this
     schema hands it all seven by default (Supabase''s `alter default privileges`), so the
     revoke in the migration is load-bearing rather than decorative. */
  select count(*) into v_n from information_schema.role_table_grants
   where table_name = 'seat_increase_claims' and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if v_n <> 0 then
    raise exception 'FAIL 8: authenticated holds % write privilege(s) on seat_increase_claims — the default-privileges grant was not revoked', v_n;
  end if;

  raise notice 'PASS: one claim per (tenant, key); browser reads its own and writes none';
end $$;

rollback;
