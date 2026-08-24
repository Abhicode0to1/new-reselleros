-- Regression test: ai_support_conversations + the support_tickets AI columns
-- (migration 20260824180000)
--
-- Run against a dev/test DB. Self-asserting: RAISEs on failure. Everything runs inside a
-- transaction that ROLLS BACK, so the DB stays clean.
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/ai_support_agent_tenant_isolation.test.sql
--
-- What it proves:
--   1. The composite FK REFUSES a transcript row pointing at another tenant's ticket.
--      RLS cannot catch this — the row's own tenant_id looks perfectly correct — so the
--      constraint is the only thing standing between two workspaces' support threads.
--   2. Deleting a ticket does NOT error, and nulls ONLY ticket_id.
--      This is the bug the column list fixes. A bare `on delete set null` on a COMPOSITE
--      key sets EVERY referencing column, including the NOT NULL tenant_id, so the DELETE
--      would be refused outright — and it would only surface the first time somebody
--      deleted a ticket that had a transcript.
--   3. The transcript SURVIVES its ticket, still carrying customer_contact.
--      Opposite choice from ai_sales_loops' cascade, deliberately: a record of what this
--      app told a real customer about their mail server is not meaningless once the ticket
--      is gone, and the contact is what makes it answerable.
--   4. The channel and resolution_status vocabularies are enforced.
--      Both are read by application code that switches on them; a row carrying a value
--      outside the set would take a branch nobody wrote.
--   5. confidence_score is bounded 0..1.
--   6. The SLA trigger still stamps tier and sla_due_at on the new insert path.
--      `stamp_support_ticket_sla` (20260817170100) is what the SLA is judged against, and
--      this migration added columns to the same table — this asserts it was not disturbed.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── Fixtures: two tenants, one ticket each ──────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('bbbbbbbb-0000-0000-0000-00000000b001'::uuid, 'SUPPORT TEST TENANT A', 'sup-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-00000000b002'::uuid, 'SUPPORT TEST TENANT B', 'sup-b@example.in', '07');

insert into public.support_tickets
  (id, tenant_id, customer_name, raised_by_email, category, priority, subject, body, status, channel)
values
  ('TKT-SUP-A', 'bbbbbbbb-0000-0000-0000-00000000b001'::uuid, 'Acme A', 'asha@acme-a.in',
   'tech', 'normal', 'Outlook not syncing', 'It stopped this morning.', 'open', 'email'),
  ('TKT-SUP-B', 'bbbbbbbb-0000-0000-0000-00000000b002'::uuid, 'Acme B', 'bala@acme-b.in',
   'tech', 'normal', 'MX records', 'What do I put in DNS?', 'open', 'email');

-- ── Test 1: a cross-tenant ticket_id must be impossible ─────────────────────
do $$
declare ok boolean := false;
begin
  begin
    -- Tenant A's row, pointing at tenant B's ticket. Both values exist; the PAIR does not.
    insert into public.ai_support_conversations
      (tenant_id, ticket_id, channel, customer_contact, role, message_content)
    values
      ('bbbbbbbb-0000-0000-0000-00000000b001'::uuid, 'TKT-SUP-B',
       'email', 'x@example.in', 'user', 'can I read tenant B''s ticket?');
  exception when foreign_key_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 1: a transcript row was allowed to point at ANOTHER TENANT''S ticket';
  end if;
  raise notice 'PASS 1: composite FK refused the cross-tenant ticket_id';
end $$;

-- ── Test 2 + 3: same-tenant insert works; deleting the ticket nulls ONLY ticket_id ──
insert into public.ai_support_conversations
  (tenant_id, ticket_id, channel, customer_contact, role, message_content,
   intent, resolution_status, confidence_score)
values
  ('bbbbbbbb-0000-0000-0000-00000000b001'::uuid, 'TKT-SUP-A',
   'email', 'asha@acme-a.in', 'user', 'Outlook keeps asking for the password.',
   'mail_client_sync', null, null),
  ('bbbbbbbb-0000-0000-0000-00000000b001'::uuid, 'TKT-SUP-A',
   'email', 'asha@acme-a.in', 'agent', 'With 2-Step on, Outlook needs an app password.',
   'mail_client_sync', 'resolved', 0.910);

do $$
declare
  v_before int;
  v_after  int;
  v_orphan_tenant uuid;
  v_orphan_contact text;
begin
  select count(*) into v_before
    from public.ai_support_conversations
   where tenant_id = 'bbbbbbbb-0000-0000-0000-00000000b001'::uuid;
  if v_before <> 2 then
    raise exception 'FAIL 2 setup: expected 2 transcript rows, got %', v_before;
  end if;

  -- The DELETE itself is the assertion. With a bare `on delete set null` this raises
  -- 23502 (null value in column "tenant_id") and the test stops here.
  delete from public.support_tickets
   where tenant_id = 'bbbbbbbb-0000-0000-0000-00000000b001'::uuid and id = 'TKT-SUP-A';

  select count(*) into v_after
    from public.ai_support_conversations
   where tenant_id = 'bbbbbbbb-0000-0000-0000-00000000b001'::uuid
     and ticket_id is null;
  if v_after <> 2 then
    raise exception 'FAIL 2: expected 2 rows with a nulled ticket_id, got %', v_after;
  end if;
  raise notice 'PASS 2: deleting a ticket nulled ONLY ticket_id, on both rows';

  select tenant_id, customer_contact into v_orphan_tenant, v_orphan_contact
    from public.ai_support_conversations
   where ticket_id is null
     and tenant_id = 'bbbbbbbb-0000-0000-0000-00000000b001'::uuid
   limit 1;
  if v_orphan_tenant is null or v_orphan_contact <> 'asha@acme-a.in' then
    raise exception 'FAIL 3: the surviving transcript lost its tenant or its contact (tenant=%, contact=%)',
      v_orphan_tenant, v_orphan_contact;
  end if;
  raise notice 'PASS 3: the transcript survived its ticket, still answerable at %', v_orphan_contact;
end $$;

-- ── Test 4: the two vocabularies are enforced ───────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.ai_support_conversations
      (tenant_id, ticket_id, channel, customer_contact, role, message_content)
    values
      ('bbbbbbbb-0000-0000-0000-00000000b002'::uuid, 'TKT-SUP-B',
       'telepathy', 'bala@acme-b.in', 'user', 'hello');
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 4a: an unknown channel was accepted';
  end if;

  ok := false;
  begin
    insert into public.ai_support_conversations
      (tenant_id, ticket_id, channel, customer_contact, role, message_content, resolution_status)
    values
      ('bbbbbbbb-0000-0000-0000-00000000b002'::uuid, 'TKT-SUP-B',
       'email', 'bala@acme-b.in', 'agent', 'hello', 'sort_of_fixed');
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 4b: an unknown resolution_status was accepted';
  end if;
  raise notice 'PASS 4: channel and resolution_status both refuse a value outside the set';
end $$;

-- ── Test 5: confidence is bounded ───────────────────────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.ai_support_conversations
      (tenant_id, ticket_id, channel, customer_contact, role, message_content, confidence_score)
    values
      ('bbbbbbbb-0000-0000-0000-00000000b002'::uuid, 'TKT-SUP-B',
       'email', 'bala@acme-b.in', 'agent', 'hello', 1.500);
  exception when check_violation then
    ok := true;
  end;
  if not ok then
    raise exception 'FAIL 5: a confidence above 1 was accepted';
  end if;
  raise notice 'PASS 5: confidence_score is bounded 0..1';
end $$;

-- ── Test 6: the SLA trigger still fires on this insert path ─────────────────
do $$
declare
  v_tier text;
  v_due  timestamptz;
begin
  insert into public.support_tickets
    (id, tenant_id, customer_name, raised_by_email, category, priority, subject, body, status, channel)
  values
    ('TKT-SUP-SLA', 'bbbbbbbb-0000-0000-0000-00000000b002'::uuid, 'Acme B', 'bala@acme-b.in',
     'tech', 'normal', 'Storage full', 'Mailbox is at 100%.', 'open', 'whatsapp');

  select tier, sla_due_at into v_tier, v_due
    from public.support_tickets
   where tenant_id = 'bbbbbbbb-0000-0000-0000-00000000b002'::uuid and id = 'TKT-SUP-SLA';

  -- The tier depends on the customer's plan and this fixture has no customer, so the value
  -- itself is not asserted — only that the trigger RAN and produced a deadline. That is the
  -- part this migration could have broken by touching the same table.
  if v_due is null then
    raise exception 'FAIL 6: stamp_support_ticket_sla did not set sla_due_at (tier=%)', coalesce(v_tier, 'null');
  end if;
  raise notice 'PASS 6: the SLA trigger still stamps a deadline (tier=%, due=%)',
    coalesce(v_tier, 'null'), v_due;
end $$;

rollback;
