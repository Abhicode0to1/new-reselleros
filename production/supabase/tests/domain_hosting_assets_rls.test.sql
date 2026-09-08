-- RLS test for the domain / hosting asset tables (migration 20260908100000).
--
-- Proves, in one rolled-back transaction:
--   1. Tenant isolation — staff of tenant A cannot see tenant B's domain.
--   2. Customer isolation — portal customer A cannot see customer B's domain,
--      even inside the same tenant.
--   3. A portal customer cannot INSERT, UPDATE or DELETE an asset. Assets are
--      created by provisioning, never by a browser.
--   4. `domains.domain_name` is unique GLOBALLY, not per tenant — two tenants
--      cannot both hold example.com.
--   5. `dns_records` visibility follows domain ownership, so there is exactly
--      one definition of "yours".
--   6. An MX record without a priority is refused (a null MX priority is a mail
--      outage, so it is a constraint and not a convention).
--
-- ─── TWO TRAPS THIS FILE DELIBERATELY AVOIDS ─────────────────────────────────
-- Both are lessons already paid for in this suite, not hypotheticals.
--
-- (a) `portal_customer_users_no_self_update.test.sql` passed for years against a
--     statement that could never have matched a row: it SELECTed an id *after*
--     `set local role authenticated`, RLS filtered the read, the id came back
--     NULL, and `where auth_user_id = NULL` matched nothing whatever the policy
--     said. Every id below is therefore captured BEFORE the role switch and
--     carried in a transaction-local GUC, and each negative case asserts the
--     statement was VALID before asserting that it was refused.
--
-- (b) `resellersos-env` §3: assert on the specific error, not on "0 rows
--     changed". A row-count assertion passes for the wrong reason the day the
--     thing it guards is dropped.
--
-- Run:  npx supabase db query --linked -f supabase/tests/domain_hosting_assets_rls.test.sql
-- Exit 0 = pass. Mutate one assertion and confirm it goes red before believing a green.

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── fixture ──────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('ffffffff-0000-0000-0000-00000000d001', 'DOM T A', 'doma@example.in', '07', 'DMA1'),
  ('ffffffff-0000-0000-0000-00000000d002', 'DOM T B', 'domb@example.in', '07', 'DMB1');

insert into public.customers (id, tenant_id, name, contact_email) values
  ('cccccccc-0000-0000-0000-00000000d001', 'ffffffff-0000-0000-0000-00000000d001', 'Cust A', 'a@dom.in'),
  ('cccccccc-0000-0000-0000-00000000d002', 'ffffffff-0000-0000-0000-00000000d001', 'Cust B', 'b@dom.in'),
  ('cccccccc-0000-0000-0000-00000000d003', 'ffffffff-0000-0000-0000-00000000d002', 'Cust C', 'c@dom.in');

-- Own auth user rather than borrowing a real one (AGENTS.md L11).
insert into auth.users (id, email) values
  ('ffffffff-0000-0000-0000-00000000e001', 'domain-tester@example.test');

insert into public.customer_users (auth_user_id, customer_id, tenant_id, email, role) values
  ('ffffffff-0000-0000-0000-00000000e001', 'cccccccc-0000-0000-0000-00000000d001',
   'ffffffff-0000-0000-0000-00000000d001', 'a@dom.in', 'admin');

insert into public.domains (id, tenant_id, customer_id, domain_name, tld, status, registrar_order_id) values
  -- customer A, tenant A — the one the portal user may see
  ('dddddddd-0000-0000-0000-00000000d001', 'ffffffff-0000-0000-0000-00000000d001',
   'cccccccc-0000-0000-0000-00000000d001', 'mine-a.example', 'example', 'active', 'RC-1'),
  -- customer B, SAME tenant — must be invisible to customer A
  ('dddddddd-0000-0000-0000-00000000d002', 'ffffffff-0000-0000-0000-00000000d001',
   'cccccccc-0000-0000-0000-00000000d002', 'other-b.example', 'example', 'active', 'RC-2'),
  -- tenant B — must be invisible to tenant A's staff
  ('dddddddd-0000-0000-0000-00000000d003', 'ffffffff-0000-0000-0000-00000000d002',
   'cccccccc-0000-0000-0000-00000000d003', 'other-tenant.example', 'example', 'active', 'RC-3');

insert into public.hosting_accounts (id, tenant_id, customer_id, domain_name, status, da_username) values
  ('11111111-0000-0000-0000-00000000d001', 'ffffffff-0000-0000-0000-00000000d001',
   'cccccccc-0000-0000-0000-00000000d001', 'mine-a.example', 'active', 'minea01'),
  ('11111111-0000-0000-0000-00000000d002', 'ffffffff-0000-0000-0000-00000000d001',
   'cccccccc-0000-0000-0000-00000000d002', 'other-b.example', 'active', 'otherb01');

insert into public.dns_records (id, tenant_id, domain_id, record_type, host, value) values
  ('22222222-0000-0000-0000-00000000d001', 'ffffffff-0000-0000-0000-00000000d001',
   'dddddddd-0000-0000-0000-00000000d001', 'A', '@', '203.0.113.10'),
  ('22222222-0000-0000-0000-00000000d002', 'ffffffff-0000-0000-0000-00000000d001',
   'dddddddd-0000-0000-0000-00000000d002', 'A', '@', '203.0.113.20');

-- ── 4. global uniqueness of domain_name (service_role, before any role switch) ─
do $$
declare v_raised boolean := false;
begin
  begin
    insert into public.domains (tenant_id, customer_id, domain_name, tld)
    values ('ffffffff-0000-0000-0000-00000000d002', 'cccccccc-0000-0000-0000-00000000d003',
            'mine-a.example', 'example');
  exception when unique_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL(4): a second tenant registered mine-a.example — domain_name is not globally unique';
  end if;
end $$;

-- ── 6. MX without priority is refused ────────────────────────────────────────
do $$
declare v_raised boolean := false;
begin
  begin
    insert into public.dns_records (tenant_id, domain_id, record_type, host, value)
    values ('ffffffff-0000-0000-0000-00000000d001', 'dddddddd-0000-0000-0000-00000000d001',
            'MX', '@', 'mail.example.com');
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL(6): an MX record with a null priority was accepted';
  end if;

  -- and the positive half: WITH a priority it goes in, so the check is not
  -- simply refusing every MX.
  insert into public.dns_records (tenant_id, domain_id, record_type, host, value, priority)
  values ('ffffffff-0000-0000-0000-00000000d001', 'dddddddd-0000-0000-0000-00000000d001',
          'MX', '@', 'mail.example.com', 10);
end $$;

-- Captured while the connection can still see them. See trap (a) in the header.
select set_config('dom.uid', 'ffffffff-0000-0000-0000-00000000e001', true);

-- ═════════════════════════════════════════════════════════════════════════════
-- As the portal customer (customer A)
-- ═════════════════════════════════════════════════════════════════════════════
set local role authenticated;

do $$
declare
  v_uid   text := current_setting('dom.uid', true);
  v_cnt   int;
  v_raised boolean;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- Guard the guard: without a real uid every assertion below passes for free.
  if v_uid is null or v_uid = '' then
    raise exception 'SETUP FAIL: dom.uid is empty — every case below would pass against nothing';
  end if;
  if auth.uid()::text <> v_uid then
    raise exception 'SETUP FAIL: auth.uid() is %, expected %', auth.uid(), v_uid;
  end if;
  if public.current_customer_id() <> 'cccccccc-0000-0000-0000-00000000d001' then
    raise exception 'SETUP FAIL: current_customer_id() is %, expected Cust A',
      public.current_customer_id();
  end if;

  -- 2. Customer isolation — sees exactly their own one domain.
  select count(*) into v_cnt from public.domains;
  if v_cnt <> 1 then
    raise exception 'FAIL(2): customer A sees % domains, expected exactly 1', v_cnt;
  end if;
  select count(*) into v_cnt from public.domains where id = 'dddddddd-0000-0000-0000-00000000d002';
  if v_cnt <> 0 then
    raise exception 'FAIL(2): customer A can see customer B''s domain';
  end if;

  select count(*) into v_cnt from public.hosting_accounts;
  if v_cnt <> 1 then
    raise exception 'FAIL(2): customer A sees % hosting accounts, expected exactly 1', v_cnt;
  end if;

  -- 5. DNS visibility follows domain ownership: the A record on their own
  --    domain plus the MX added above = 2; customer B's record is not theirs.
  select count(*) into v_cnt from public.dns_records;
  if v_cnt <> 2 then
    raise exception 'FAIL(5): customer A sees % dns_records, expected 2 (own domain only)', v_cnt;
  end if;
  select count(*) into v_cnt from public.dns_records where id = '22222222-0000-0000-0000-00000000d002';
  if v_cnt <> 0 then
    raise exception 'FAIL(5): customer A can see DNS for customer B''s domain';
  end if;

  -- 3a. No UPDATE. Asserted on the ERROR, not on a row count — and the row it
  --     targets is one the customer can genuinely see, so a refusal here is the
  --     policy talking and not a filtered-away id (trap (a)).
  v_raised := false;
  begin
    update public.domains set auto_renew = true
     where id = 'dddddddd-0000-0000-0000-00000000d001';
    -- An UPDATE with no matching permissive policy raises rather than
    -- silently matching zero rows, because SELECT can see the row.
  exception when insufficient_privilege then
    v_raised := true;
  end;
  if not v_raised then
    -- Postgres may report 0 rows instead of raising depending on how the
    -- policies compose; that is still a pass ONLY if the value really is
    -- unchanged. Check the value, never the row count alone.
    if exists (select 1 from public.domains
                where id = 'dddddddd-0000-0000-0000-00000000d001' and auto_renew) then
      raise exception 'FAIL(3a): a portal customer flipped auto_renew on their own domain — 0063 says that door is shut';
    end if;
  end if;

  -- 3b. No INSERT.
  v_raised := false;
  begin
    insert into public.domains (tenant_id, customer_id, domain_name, tld)
    values ('ffffffff-0000-0000-0000-00000000d001', 'cccccccc-0000-0000-0000-00000000d001',
            'self-registered.example', 'example');
  exception when insufficient_privilege then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL(3b): a portal customer created a domain asset from the browser';
  end if;

  -- 3c. No DELETE.
  v_raised := false;
  begin
    delete from public.domains where id = 'dddddddd-0000-0000-0000-00000000d001';
  exception when insufficient_privilege then
    v_raised := true;
  end;
  if not v_raised then
    if not exists (select 1 from public.domains where id = 'dddddddd-0000-0000-0000-00000000d001') then
      raise exception 'FAIL(3c): a portal customer deleted their own domain asset';
    end if;
  end if;
end $$;

reset role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Tenant isolation for STAFF
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Staff read through `current_tenant_id()`, which resolves from public.users —
-- a different path from the customer one above, so it needs its own case.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('ffffffff-0000-0000-0000-00000000e002', 'staff-a@example.test');

insert into public.users (id, tenant_id, email, full_name, role) values
  ('ffffffff-0000-0000-0000-00000000e002', 'ffffffff-0000-0000-0000-00000000d001',
   'staff-a@example.test', 'Staff A', 'owner');

select set_config('dom.staff', 'ffffffff-0000-0000-0000-00000000e002', true);

set local role authenticated;

do $$
declare v_uid text := current_setting('dom.staff', true); v_cnt int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  if public.current_tenant_id() <> 'ffffffff-0000-0000-0000-00000000d001' then
    raise exception 'SETUP FAIL: staff tenant is %, expected tenant A', public.current_tenant_id();
  end if;

  -- Tenant A holds two domains; tenant B's third must not appear.
  select count(*) into v_cnt from public.domains;
  if v_cnt <> 2 then
    raise exception 'FAIL(1): tenant A staff sees % domains, expected 2', v_cnt;
  end if;
  select count(*) into v_cnt from public.domains where id = 'dddddddd-0000-0000-0000-00000000d003';
  if v_cnt <> 0 then
    raise exception 'FAIL(1): tenant A staff can see tenant B''s domain';
  end if;

  select count(*) into v_cnt from public.hosting_accounts;
  if v_cnt <> 2 then
    raise exception 'FAIL(1): tenant A staff sees % hosting accounts, expected 2', v_cnt;
  end if;
end $$;

reset role;

rollback;
