-- Regression test: ai_telecall_logs (migration 20260825120000)
--
-- Run against a dev/test DB. Self-asserting: RAISEs on failure. Everything runs inside a
-- transaction that ROLLS BACK, so the DB stays clean.
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/ai_telecalling_tenant_isolation.test.sql
--
-- What it proves:
--   1. The composite FK REFUSES a call log pointing at another tenant's lead.
--      RLS cannot catch this — the row's own tenant_id looks perfectly correct — so the
--      constraint is the only thing standing between two workspaces' call transcripts.
--   2. The same for a subscription, which needed its own unique key added.
--   3. Deleting a lead does NOT error, and nulls ONLY lead_id.
--      This is the bug the column list on `on delete set null` fixes. A bare form on a
--      COMPOSITE key sets EVERY referencing column, including the NOT NULL tenant_id, so the
--      DELETE would be refused outright — and it would only show up the first time somebody
--      deleted a lead that had been rung.
--   4. One provider_call_id per tenant. This is the retry guard: both vendors re-POST a
--      post-call webhook on a slow response, and without this one conversation becomes two
--      rows — and, because the webhook can trigger a quotation, two quotes.
--   5. A row about NOTHING is refused. lead_id and subscription_id both null is a call
--      nobody can act on.
--   6. A phone number that is not E.164 is refused. The app normalises before insert; this is
--      the backstop for anything that does not.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── Fixtures: two tenants, a lead and a subscription each ───────────────────
insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TELECALL TEST TENANT A', 'tc-a@example.in', '07'),
  ('cccccccc-0000-0000-0000-00000000c002'::uuid, 'TELECALL TEST TENANT B', 'tc-b@example.in', '07');

insert into public.leads (id, tenant_id, company, stage, priority, country) values
  ('L-TELECALL-A', 'cccccccc-0000-0000-0000-00000000c001'::uuid, 'Acme A', 'new', 'medium', 'India'),
  ('L-TELECALL-B', 'cccccccc-0000-0000-0000-00000000c002'::uuid, 'Acme B', 'new', 'medium', 'India');

insert into public.subscriptions
  (id, tenant_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, status)
values
  ('cccccccc-1111-4111-8111-00000000d001'::uuid, 'cccccccc-0000-0000-0000-00000000c001'::uuid,
   'Acme A', 'Google Workspace Business Standard', 'google', 5, 4320, '2026-01-01', '2026-09-01', 'active'),
  ('cccccccc-1111-4111-8111-00000000d002'::uuid, 'cccccccc-0000-0000-0000-00000000c002'::uuid,
   'Acme B', 'Google Workspace Business Standard', 'google', 5, 4320, '2026-01-01', '2026-09-01', 'active');

-- ── Test 1: a cross-tenant lead_id must be impossible ───────────────────────
do $$
declare ok boolean := false;
begin
  begin
    -- Tenant A's row, pointing at tenant B's lead. Both values exist; the PAIR does not.
    insert into public.ai_telecall_logs
      (tenant_id, lead_id, call_type, phone_number)
    values
      ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'L-TELECALL-B',
       'lead_qualification', '+919876500001');
  exception when foreign_key_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 1: a call log was allowed to point at ANOTHER TENANT''S lead';
  end if;
  raise notice 'PASS 1: composite FK refused the cross-tenant lead_id';
end $$;

-- ── Test 2: the same for a subscription ─────────────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.ai_telecall_logs
      (tenant_id, subscription_id, call_type, phone_number)
    values
      ('cccccccc-0000-0000-0000-00000000c001'::uuid,
       'cccccccc-1111-4111-8111-00000000d002'::uuid,
       'renewal_reminder', '+919876500002');
  exception when foreign_key_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 2: a call log was allowed to point at ANOTHER TENANT''S subscription';
  end if;
  raise notice 'PASS 2: composite FK refused the cross-tenant subscription_id';
end $$;

-- ── Test 3: same-tenant insert works, and deleting the lead nulls ONLY lead_id ──
insert into public.ai_telecall_logs
  (tenant_id, lead_id, call_type, phone_number, status, transcript, action_taken)
values
  ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'L-TELECALL-A',
   'lead_qualification', '+919876500003', 'completed', 'Agent: hello', 'quote_requested');

do $$
declare
  remaining int;
  orphan_tenant uuid;
  orphan_lead   text;
begin
  -- This is the assertion that matters: the DELETE must SUCCEED. With a bare
  -- `on delete set null` it would be refused, because Postgres would try to null tenant_id.
  delete from public.leads
   where tenant_id = 'cccccccc-0000-0000-0000-00000000c001'::uuid
     and id = 'L-TELECALL-A';

  select count(*) into remaining
    from public.ai_telecall_logs
   where tenant_id = 'cccccccc-0000-0000-0000-00000000c001'::uuid
     and phone_number = '+919876500003';

  if remaining <> 1 then
    raise exception 'FAIL 3a: the call record vanished with the lead (found %, expected 1). '
                    'A record of what we said to a real person is not deletable bookkeeping.',
                    remaining;
  end if;

  select tenant_id, lead_id into orphan_tenant, orphan_lead
    from public.ai_telecall_logs
   where phone_number = '+919876500003';

  if orphan_lead is not null then
    raise exception 'FAIL 3b: lead_id was not nulled (still %)', orphan_lead;
  end if;
  if orphan_tenant is null then
    raise exception 'FAIL 3c: tenant_id was nulled too — the column list on SET NULL is missing';
  end if;
  raise notice 'PASS 3: the lead deleted cleanly, lead_id nulled, tenant_id intact';
end $$;

-- ── Test 4: one provider_call_id per tenant ─────────────────────────────────
insert into public.ai_telecall_logs
  (tenant_id, subscription_id, call_type, phone_number, status, provider, provider_call_id)
values
  ('cccccccc-0000-0000-0000-00000000c001'::uuid,
   'cccccccc-1111-4111-8111-00000000d001'::uuid,
   'renewal_reminder', '+919876500004', 'queued', 'retell', 'call_retry_me');

do $$
declare ok boolean := false;
begin
  begin
    -- The retry. Same tenant, same vendor call id.
    insert into public.ai_telecall_logs
      (tenant_id, subscription_id, call_type, phone_number, status, provider, provider_call_id)
    values
      ('cccccccc-0000-0000-0000-00000000c001'::uuid,
       'cccccccc-1111-4111-8111-00000000d001'::uuid,
       'renewal_reminder', '+919876500004', 'completed', 'retell', 'call_retry_me');
  exception when unique_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 4: a retried post-call webhook created a SECOND row for one call';
  end if;
  raise notice 'PASS 4: the unique index refused the duplicate provider_call_id';
end $$;

-- ── Test 4b: but NULL provider_call_id may repeat ───────────────────────────
-- Held and refused rows never reached a vendor and have no id to claim. If the index refused
-- these, the dial at `hold` could file exactly one call per tenant, ever.
insert into public.ai_telecall_logs
  (tenant_id, subscription_id, call_type, phone_number, status)
values
  ('cccccccc-0000-0000-0000-00000000c001'::uuid,
   'cccccccc-1111-4111-8111-00000000d001'::uuid, 'renewal_reminder', '+919876500005', 'held'),
  ('cccccccc-0000-0000-0000-00000000c001'::uuid,
   'cccccccc-1111-4111-8111-00000000d001'::uuid, 'renewal_reminder', '+919876500006', 'held');
do $$
begin
  raise notice 'PASS 4b: two held rows with no provider_call_id coexist';
end $$;

-- ── Test 5: a row about nothing is refused ──────────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.ai_telecall_logs (tenant_id, call_type, phone_number)
    values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'lead_qualification', '+919876500007');
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 5: a call log with neither a lead nor a subscription was accepted';
  end if;
  raise notice 'PASS 5: a call about nothing was refused';
end $$;

-- ── Test 6: the phone number must be E.164 ──────────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.ai_telecall_logs
      (tenant_id, subscription_id, call_type, phone_number)
    values
      ('cccccccc-0000-0000-0000-00000000c001'::uuid,
       'cccccccc-1111-4111-8111-00000000d001'::uuid, 'renewal_reminder', '98765 43210');
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 6: a non-E.164 phone number was accepted — the log cannot then answer '
                    '"did we already ring this number today"';
  end if;
  raise notice 'PASS 6: the E.164 check refused a locally-formatted number';
end $$;

-- ── Test 7: RLS is on, and writes are service-role only ─────────────────────
do $$
declare
  rls_on boolean;
  policy_count int;
begin
  select relrowsecurity into rls_on from pg_class where oid = 'public.ai_telecall_logs'::regclass;
  if not rls_on then
    raise exception 'FAIL 7a: row level security is not enabled on ai_telecall_logs';
  end if;

  select count(*) into policy_count from pg_policies
   where schemaname = 'public' and tablename = 'ai_telecall_logs';
  if policy_count < 2 then
    raise exception 'FAIL 7b: expected a select policy and a service-role policy, found %', policy_count;
  end if;
  raise notice 'PASS 7: RLS on, % policies present', policy_count;
end $$;

rollback;
