-- Regression test: support agent tooling (notes / time logs / canned responses)
-- from migration 20260907120000 — DSP-merge brick 1.
-- Every block rolls back — safe to run against any database, including prod.
--
-- Proves:
--   1. CROSS-TENANT LINK REFUSED — a note/time-log row whose tenant_id and
--      ticket_id belong to DIFFERENT tenants dies on the composite FK, even
--      though both halves exist.
--   2. ISOLATION (notes)  — tenant A's agent reads exactly their own note and
--      ZERO of tenant B's (control proves B's row exists).
--   3. ISOLATION (canned) — same for canned responses, plus the per-tenant
--      title uniqueness (same title in two tenants is fine; twice in one is not).
--   4. TIME LOG BOUNDS — minutes=0 and minutes=1441 are refused by CHECK.
--   5. INSERT AS AGENT — the authenticated role can actually write (a policy
--      that blocks everything also "passes" isolation — this is the control).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── Fixtures: two tenants, one agent each, one ticket each ──────────────────
insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TOOLING TEST TENANT A', 'tool-a@example.test', '07'),
  ('cccccccc-0000-0000-0000-00000000c002'::uuid, 'TOOLING TEST TENANT B', 'tool-b@example.test', '07');

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-00000000c0a1'::uuid, 'agent-a@example.test'),
  ('cccccccc-0000-0000-0000-00000000c0b1'::uuid, 'agent-b@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('cccccccc-0000-0000-0000-00000000c0a1'::uuid, 'cccccccc-0000-0000-0000-00000000c001'::uuid,
   'agent-a@example.test', 'Agent A', 'owner', true),
  ('cccccccc-0000-0000-0000-00000000c0b1'::uuid, 'cccccccc-0000-0000-0000-00000000c002'::uuid,
   'agent-b@example.test', 'Agent B', 'owner', true);

insert into public.support_tickets
  (id, tenant_id, customer_name, raised_by_email, category, priority, subject, body, status)
values
  ('TKT-TOOL-A', 'cccccccc-0000-0000-0000-00000000c001'::uuid, 'Acme A', 'a@acme-a.test',
   'tech', 'normal', 'Ticket A', 'body', 'open'),
  ('TKT-TOOL-B', 'cccccccc-0000-0000-0000-00000000c002'::uuid, 'Acme B', 'b@acme-b.test',
   'tech', 'normal', 'Ticket B', 'body', 'open');

-- Tenant B gets one of each row (service-side), so tenant A's "sees zero"
-- assertions below have something real to NOT see.
insert into public.support_ticket_notes (tenant_id, ticket_id, author_id, author_name, body)
values ('cccccccc-0000-0000-0000-00000000c002'::uuid, 'TKT-TOOL-B',
        'cccccccc-0000-0000-0000-00000000c0b1'::uuid, 'Agent B', 'B-private note');
insert into public.support_canned_responses (tenant_id, title, body, created_by)
values ('cccccccc-0000-0000-0000-00000000c002'::uuid, 'Greeting', 'Hello from B',
        'cccccccc-0000-0000-0000-00000000c0b1'::uuid);

-- ── 1. Cross-tenant link refused by the composite FK ────────────────────────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.support_ticket_notes (tenant_id, ticket_id, author_name, body)
    values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TKT-TOOL-B', 'Agent A', 'crossing the wall');
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 1a: cross-tenant NOTE link was accepted'; end if;

  ok := false;
  begin
    insert into public.support_ticket_time_logs (tenant_id, ticket_id, user_name, minutes)
    values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TKT-TOOL-B', 'Agent A', 30);
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 1b: cross-tenant TIME LOG link was accepted'; end if;
end $$;

-- ── 4. Time-log bounds (still service-side; CHECK is role-independent) ─────
do $$
declare ok boolean := false;
begin
  begin
    insert into public.support_ticket_time_logs (tenant_id, ticket_id, user_name, minutes)
    values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TKT-TOOL-A', 'Agent A', 0);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 4a: minutes=0 was accepted'; end if;

  ok := false;
  begin
    insert into public.support_ticket_time_logs (tenant_id, ticket_id, user_name, minutes)
    values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TKT-TOOL-A', 'Agent A', 1441);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 4b: minutes=1441 was accepted'; end if;
end $$;

-- ── Switch to tenant A's agent, RLS enforced ────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'cccccccc-0000-0000-0000-00000000c0a1',
                    'role', 'authenticated')::text, true);

-- ── 5. The agent can actually write (control for every isolation pass) ─────
insert into public.support_ticket_notes (tenant_id, ticket_id, author_id, author_name, body)
values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TKT-TOOL-A',
        'cccccccc-0000-0000-0000-00000000c0a1'::uuid, 'Agent A', 'A-note');
insert into public.support_ticket_time_logs (tenant_id, ticket_id, user_id, user_name, minutes, note)
values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'TKT-TOOL-A',
        'cccccccc-0000-0000-0000-00000000c0a1'::uuid, 'Agent A', 25, 'diagnosed DNS');
insert into public.support_canned_responses (tenant_id, title, body, created_by)
values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'Greeting', 'Hello from A',
        'cccccccc-0000-0000-0000-00000000c0a1'::uuid);

-- ── 2 + 3. Isolation, with explicit counts (khaali-loop guard) ──────────────
do $$
declare n int;
begin
  select count(*) into n from public.support_ticket_notes;
  if n <> 1 then raise exception 'FAIL 2a: agent A sees % notes, expected exactly 1 (own)', n; end if;

  select count(*) into n from public.support_ticket_notes where body = 'B-private note';
  if n <> 0 then raise exception 'FAIL 2b: agent A can read tenant B''s internal note'; end if;

  select count(*) into n from public.support_ticket_time_logs;
  if n <> 1 then raise exception 'FAIL 2c: agent A sees % time logs, expected exactly 1', n; end if;

  select count(*) into n from public.support_canned_responses;
  if n <> 1 then raise exception 'FAIL 3a: agent A sees % canned responses, expected exactly 1', n; end if;

  -- Same title as tenant B ('Greeting') was ACCEPTED above — uniqueness is
  -- per-tenant. Now the same title AGAIN in tenant A must be refused.
end $$;

do $$
declare ok boolean := false;
begin
  begin
    insert into public.support_canned_responses (tenant_id, title, body)
    values ('cccccccc-0000-0000-0000-00000000c001'::uuid, 'Greeting', 'duplicate');
  exception when unique_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL 3b: duplicate canned title inside one tenant was accepted'; end if;
end $$;

select 'support_agent_tooling: ALL PASS' as result;

rollback;
