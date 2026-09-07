-- Regression test: support ticket CSAT ratings (migration 20260907150000) —
-- DSP-merge brick 3. Every block rolls back — safe on any database, incl. prod.
--
-- Proves:
--   1. CUSTOMER RATES OWN RESOLVED TICKET — the intended path works (control).
--   2. ONE VERDICT — rating the same ticket again dies on the unique key.
--   3. NOT MID-FLIGHT — an OPEN ticket cannot be rated (policy refuses).
--   4. NOT SOMEBODY ELSE'S — the same portal customer cannot rate another
--      customer's ticket, even inside the same tenant.
--   5. AGENT READS, TENANT-SCOPED — tenant A's agent sees exactly 1 rating;
--      tenant B's agent sees 0 (control: A's rating exists).
--   6. BOUNDS — score 0 and 6 are refused by CHECK.
--   7. CROSS-TENANT LINK — composite FK refuses a row pairing tenant A with
--      tenant B's ticket.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'CSAT TEST TENANT A', 'csat-a@example.test', '07'),
  ('dddddddd-0000-0000-0000-00000000d002'::uuid, 'CSAT TEST TENANT B', 'csat-b@example.test', '07');

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-00000000d0c1'::uuid, 'csat-portal@example.test'),  -- portal customer
  ('dddddddd-0000-0000-0000-00000000d0a1'::uuid, 'csat-agent-a@example.test'), -- tenant A agent
  ('dddddddd-0000-0000-0000-00000000d0b1'::uuid, 'csat-agent-b@example.test'); -- tenant B agent

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('dddddddd-0000-0000-0000-00000000d0a1'::uuid, 'dddddddd-0000-0000-0000-00000000d001'::uuid,
   'csat-agent-a@example.test', 'CSAT Agent A', 'owner', true),
  ('dddddddd-0000-0000-0000-00000000d0b1'::uuid, 'dddddddd-0000-0000-0000-00000000d002'::uuid,
   'csat-agent-b@example.test', 'CSAT Agent B', 'owner', true);

insert into public.customers (id, tenant_id, name, contact_email) values
  ('dddddddd-0000-0000-0000-00000000dcc1'::uuid, 'dddddddd-0000-0000-0000-00000000d001'::uuid,
   'CSAT Cust One', 'one@csat.test'),
  ('dddddddd-0000-0000-0000-00000000dcc2'::uuid, 'dddddddd-0000-0000-0000-00000000d001'::uuid,
   'CSAT Cust Two', 'two@csat.test');

-- The portal identity: auth user d0c1 IS customer One (and nobody else).
insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role) values
  ('dddddddd-0000-0000-0000-00000000d0c1'::uuid, 'dddddddd-0000-0000-0000-00000000dcc1'::uuid,
   'dddddddd-0000-0000-0000-00000000d001'::uuid, 'one@csat.test', 'admin');

insert into public.support_tickets
  (id, tenant_id, customer_id, customer_name, raised_by_email, category, priority,
   subject, body, status, resolved_at)
values
  -- customer One's ticket, RESOLVED — the rateable one
  ('TKT-CSAT-RES', 'dddddddd-0000-0000-0000-00000000d001'::uuid,
   'dddddddd-0000-0000-0000-00000000dcc1'::uuid, 'CSAT Cust One', 'one@csat.test',
   'tech', 'normal', 'Fixed thing', 'body', 'resolved', now()),
  -- customer One's ticket, still OPEN — must not be rateable
  ('TKT-CSAT-OPEN', 'dddddddd-0000-0000-0000-00000000d001'::uuid,
   'dddddddd-0000-0000-0000-00000000dcc1'::uuid, 'CSAT Cust One', 'one@csat.test',
   'tech', 'normal', 'Broken thing', 'body', 'open', null),
  -- customer TWO's resolved ticket — customer One must not be able to rate it
  ('TKT-CSAT-OTHER', 'dddddddd-0000-0000-0000-00000000d001'::uuid,
   'dddddddd-0000-0000-0000-00000000dcc2'::uuid, 'CSAT Cust Two', 'two@csat.test',
   'tech', 'normal', 'Other cust', 'body', 'resolved', now()),
  -- tenant B's ticket — for the composite-FK cross-tenant check
  ('TKT-CSAT-B', 'dddddddd-0000-0000-0000-00000000d002'::uuid,
   null, 'B Cust', 'b@csat.test', 'tech', 'normal', 'B ticket', 'body', 'resolved', now());

-- ── 6 + 7 still service-side: CHECK and FK are role-independent ─────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.support_ticket_ratings (tenant_id, ticket_id, score, rated_by_email)
    values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-RES', 0, 'one@csat.test');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 6a: score=0 was accepted'; end if;

  ok := false;
  begin
    insert into public.support_ticket_ratings (tenant_id, ticket_id, score, rated_by_email)
    values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-RES', 6, 'one@csat.test');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 6b: score=6 was accepted'; end if;

  ok := false;
  begin
    -- tenant A's tenant_id paired with tenant B's ticket id: both halves exist, the pair must not.
    insert into public.support_ticket_ratings (tenant_id, ticket_id, score, rated_by_email)
    values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-B', 5, 'x@csat.test');
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 7: cross-tenant rating link was accepted'; end if;
end $$;

-- ── Become the PORTAL CUSTOMER (customer One) ───────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'dddddddd-0000-0000-0000-00000000d0c1',
                    'role', 'authenticated')::text, true);

-- 1. The intended path: rate own RESOLVED ticket. If this refuses, every
--    "refused" below would pass for the wrong reason — this is the control.
insert into public.support_ticket_ratings (tenant_id, ticket_id, score, comment, rated_by_email)
values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-RES', 5,
        'Jaldi theek ho gaya, shukriya!', 'one@csat.test');

do $$
declare ok boolean := false; n int;
begin
  -- the customer can read back their own verdict
  select count(*) into n from public.support_ticket_ratings;
  if n <> 1 then raise exception 'FAIL 1: portal customer sees % ratings, expected exactly 1', n; end if;

  -- 2. one verdict per ticket
  begin
    insert into public.support_ticket_ratings (tenant_id, ticket_id, score, rated_by_email)
    values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-RES', 1, 'one@csat.test');
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 2: a second rating on the same ticket was accepted'; end if;

  -- 3. an open ticket cannot be rated (RLS with-check refuses → 42501-family)
  ok := false;
  begin
    insert into public.support_ticket_ratings (tenant_id, ticket_id, score, rated_by_email)
    values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-OPEN', 4, 'one@csat.test');
  exception when insufficient_privilege or check_violation then ok := true;
             when others then if sqlstate = '42501' then ok := true; end if;
  end;
  if not ok then raise exception 'FAIL 3: an OPEN ticket was rated'; end if;

  -- 4. another customer's ticket cannot be rated, same tenant or not
  ok := false;
  begin
    insert into public.support_ticket_ratings (tenant_id, ticket_id, score, rated_by_email)
    values ('dddddddd-0000-0000-0000-00000000d001'::uuid, 'TKT-CSAT-OTHER', 1, 'one@csat.test');
  exception when insufficient_privilege or check_violation then ok := true;
             when others then if sqlstate = '42501' then ok := true; end if;
  end;
  if not ok then raise exception 'FAIL 4: rated a ticket belonging to a different customer'; end if;
end $$;

-- ── Become tenant A's AGENT ─────────────────────────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', 'dddddddd-0000-0000-0000-00000000d0a1',
                    'role', 'authenticated')::text, true);

do $$
declare n int;
begin
  select count(*) into n from public.support_ticket_ratings;
  if n <> 1 then raise exception 'FAIL 5a: tenant A agent sees % ratings, expected exactly 1', n; end if;
  select score into n from public.support_ticket_ratings where ticket_id = 'TKT-CSAT-RES';
  if n <> 5 then raise exception 'FAIL 5b: agent reads score %, expected 5', n; end if;
end $$;

-- ── Become tenant B's AGENT — must see nothing ──────────────────────────────
select set_config('request.jwt.claims',
  json_build_object('sub', 'dddddddd-0000-0000-0000-00000000d0b1',
                    'role', 'authenticated')::text, true);

do $$
declare n int;
begin
  select count(*) into n from public.support_ticket_ratings;
  if n <> 0 then raise exception 'FAIL 5c: tenant B agent can see % of tenant A''s ratings', n; end if;
end $$;

select 'support_ticket_ratings: ALL PASS' as result;

rollback;
