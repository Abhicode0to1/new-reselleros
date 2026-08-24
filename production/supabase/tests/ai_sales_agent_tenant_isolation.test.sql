-- Regression test: ai_sales_conversations / ai_sales_loops (migration 20260824120000)
--
-- Run against a dev/test DB. Self-asserting: RAISEs on failure. Everything runs inside a
-- transaction that ROLLS BACK, so the DB stays clean.
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/ai_sales_agent_tenant_isolation.test.sql
--
-- What it proves:
--   1. The composite FK REFUSES a conversation pointing at another tenant's lead.
--      RLS cannot catch this — the row's own tenant_id looks perfectly correct — so the
--      constraint is the only thing standing between two workspaces' conversations.
--   2. Deleting a lead does NOT error, and nulls ONLY lead_id.
--      This is the bug the column list fixes. A bare `on delete set null` on a COMPOSITE
--      key sets EVERY referencing column, including the NOT NULL tenant_id, so the DELETE
--      would be refused outright — and it would only show up the first time somebody
--      deleted a lead that had a transcript.
--   3. Deleting a lead CASCADES its follow-up loops away.
--      Opposite choice from the transcript, deliberately: a scheduled nudge for a deleted
--      lead is meaningless, a record of what we said to a customer is not.
--   4. Only ONE pending loop per lead can exist.
--      Without it, two inbound messages a minute apart schedule two follow-ups and the
--      customer gets nudged twice for one silence.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── Fixtures: two tenants, one lead each ────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-00000000a001'::uuid, 'AGENT TEST TENANT A', 'agent-a@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-00000000a002'::uuid, 'AGENT TEST TENANT B', 'agent-b@example.in', '07');

insert into public.leads (id, tenant_id, company, stage, priority, country) values
  ('L-AGENT-A', 'aaaaaaaa-0000-0000-0000-00000000a001'::uuid, 'Acme A', 'new', 'medium', 'India'),
  ('L-AGENT-B', 'aaaaaaaa-0000-0000-0000-00000000a002'::uuid, 'Acme B', 'new', 'medium', 'India');

-- ── Test 1: a cross-tenant lead_id must be impossible ───────────────────────
do $$
declare ok boolean := false;
begin
  begin
    -- Tenant A's row, pointing at tenant B's lead. Both values exist; the PAIR does not.
    insert into public.ai_sales_conversations
      (tenant_id, lead_id, channel, customer_contact, role, content)
    values
      ('aaaaaaaa-0000-0000-0000-00000000a001'::uuid, 'L-AGENT-B',
       'email', 'x@example.in', 'user', 'can I see tenant B''s deal?');
  exception when foreign_key_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 1: a conversation was allowed to point at ANOTHER TENANT''S lead';
  end if;
  raise notice 'PASS 1: composite FK refused the cross-tenant lead_id';
end $$;

-- ── Test 2: same-tenant insert works, and deleting the lead nulls ONLY lead_id ──
insert into public.ai_sales_conversations
  (tenant_id, lead_id, channel, customer_contact, role, content, confidence_score)
values
  ('aaaaaaaa-0000-0000-0000-00000000a001'::uuid, 'L-AGENT-A',
   'email', 'asha@acme.in', 'user', 'how much for 12 seats?', 0.910);

insert into public.ai_sales_loops
  (tenant_id, lead_id, scheduled_at, trigger_condition)
values
  ('aaaaaaaa-0000-0000-0000-00000000a001'::uuid, 'L-AGENT-A',
   now() + interval '48 hours', 'quote sent, no reply yet');

do $$
declare n_conv int; n_loop int; kept_tenant uuid; kept_contact text;
begin
  -- The DELETE itself is the assertion. With a bare `on delete set null` this raises
  -- 23502 (not-null violation on tenant_id) and the whole test stops here.
  delete from public.leads where id = 'L-AGENT-A';

  select count(*) into n_conv from public.ai_sales_conversations
    where customer_contact = 'asha@acme.in';
  if n_conv <> 1 then
    raise exception 'FAIL 2a: the transcript row vanished — expected it to survive, found %', n_conv;
  end if;

  select tenant_id, customer_contact into kept_tenant, kept_contact
    from public.ai_sales_conversations where customer_contact = 'asha@acme.in';
  if kept_tenant is null then
    raise exception 'FAIL 2b: tenant_id was nulled — the column list on SET NULL is missing';
  end if;
  if kept_contact is null then
    raise exception 'FAIL 2c: customer_contact was nulled, so the conversation is unfindable';
  end if;
  if (select lead_id from public.ai_sales_conversations
        where customer_contact = 'asha@acme.in') is not null then
    raise exception 'FAIL 2d: lead_id was NOT nulled';
  end if;
  raise notice 'PASS 2: lead delete nulled lead_id only; transcript kept its tenant and contact';

  -- Test 3: the loop should be gone, not orphaned.
  select count(*) into n_loop from public.ai_sales_loops
    where tenant_id = 'aaaaaaaa-0000-0000-0000-00000000a001'::uuid;
  if n_loop <> 0 then
    raise exception 'FAIL 3: % follow-up loop(s) survived the lead delete', n_loop;
  end if;
  raise notice 'PASS 3: follow-up loops cascaded away with the lead';
end $$;

-- ── Test 4: at most one PENDING loop per lead ───────────────────────────────
do $$
declare ok boolean := false;
begin
  insert into public.ai_sales_loops (tenant_id, lead_id, scheduled_at, trigger_condition)
  values ('aaaaaaaa-0000-0000-0000-00000000a002'::uuid, 'L-AGENT-B',
          now() + interval '24 hours', 'first nudge');
  begin
    insert into public.ai_sales_loops (tenant_id, lead_id, scheduled_at, trigger_condition)
    values ('aaaaaaaa-0000-0000-0000-00000000a002'::uuid, 'L-AGENT-B',
            now() + interval '25 hours', 'second nudge for the same silence');
  exception when unique_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 4: a lead was allowed TWO pending follow-ups — it would be nudged twice';
  end if;

  -- And a CANCELLED one must not block a fresh pending row, or the agent could never
  -- reschedule after a customer replied.
  update public.ai_sales_loops set status = 'cancelled'
   where tenant_id = 'aaaaaaaa-0000-0000-0000-00000000a002'::uuid;
  insert into public.ai_sales_loops (tenant_id, lead_id, scheduled_at, trigger_condition)
  values ('aaaaaaaa-0000-0000-0000-00000000a002'::uuid, 'L-AGENT-B',
          now() + interval '72 hours', 'rescheduled after the customer wrote back');
  raise notice 'PASS 4: one pending loop per lead, and a cancelled one does not block a new one';
end $$;

-- ── Test 5: the confidence range is enforced ────────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.ai_sales_conversations
      (tenant_id, lead_id, channel, customer_contact, role, content, confidence_score)
    values ('aaaaaaaa-0000-0000-0000-00000000a002'::uuid, 'L-AGENT-B',
            'whatsapp', '+919000000000', 'agent', 'hello', 1.5);
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 5: a confidence score above 1 was accepted';
  end if;
  raise notice 'PASS 5: confidence_score is bounded 0..1';
end $$;

rollback;
