-- Regression test: S28 WhatsApp reminders (migration 20260928150000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/whatsapp_reminders.test.sql
--
-- What it proves:
--   1. A company owner can switch reminders on and map a template; a sales user cannot.
--   2. Another company sees none of it, cannot flip the first company's switch, and cannot
--      read its reminder log. No authenticated user can WRITE the log (server-only).
--   3. The webhook's status update on whatsapp_messages moves the log forward
--      (sent → delivered → read) and never backwards ('sent' after 'read' stays 'read').
--   4. The same (subject, step) cannot be logged as sent twice; a failed row does not block.
--   5. A log row written AFTER the status callback adopts the status already known.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000028a1', 'WAR TEST A', 'war-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000028b1', 'WAR TEST B', 'war-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000028a0a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'war-a-owner@example.in'),
  ('aaaaaaaa-0000-0000-0000-00000028a0a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'war-a-sales@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000028b0b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'war-b-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000028a0a1', 'aaaaaaaa-0000-0000-0000-0000000028a1', 'war-a-owner@example.in', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000028a0a2', 'aaaaaaaa-0000-0000-0000-0000000028a1', 'war-a-sales@example.in', 'sales'),
  ('bbbbbbbb-0000-0000-0000-00000028b0b1', 'bbbbbbbb-0000-0000-0000-0000000028b1', 'war-b-owner@example.in', 'owner');

-- Server-side rows (as the connection role = service-role equivalent)
insert into public.whatsapp_messages (id, tenant_id, wamid, contact_phone, direction, type, status) values
  ('aaaaaaaa-0000-0000-0000-0000002800e1', 'aaaaaaaa-0000-0000-0000-0000000028a1', 'wamid.TEST28.1', '+919800000001', 'outbound', 'template', 'sent'),
  ('aaaaaaaa-0000-0000-0000-0000002800e2', 'aaaaaaaa-0000-0000-0000-0000000028a1', 'wamid.TEST28.2', '+919800000001', 'outbound', 'template', 'sent');
insert into public.whatsapp_reminder_log (tenant_id, kind, subject_type, subject_id, step, phone, template_name, wamid, status, sent_at)
values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_overdue', 'invoice', 'INV-T28-1', 'reminder',
        '+919800000001', 'invoice_overdue_v1', 'wamid.TEST28.1', 'sent', now());

-- ── 3. status sync ─────────────────────────────────────────────────────────
do $$
declare s text; d timestamptz; r timestamptz;
begin
  update public.whatsapp_messages set status = 'delivered' where wamid = 'wamid.TEST28.1';
  select status, delivered_at into s, d from public.whatsapp_reminder_log where wamid = 'wamid.TEST28.1';
  if s <> 'delivered' or d is null then raise exception 'FAIL 3a: after delivered the log says % (delivered_at %)', s, d; end if;

  update public.whatsapp_messages set status = 'read' where wamid = 'wamid.TEST28.1';
  select status, read_at into s, r from public.whatsapp_reminder_log where wamid = 'wamid.TEST28.1';
  if s <> 'read' or r is null then raise exception 'FAIL 3b: after read the log says % (read_at %)', s, r; end if;

  -- webhook maps an unknown status to 'sent' — must not regress
  update public.whatsapp_messages set status = 'sent' where wamid = 'wamid.TEST28.1';
  update public.whatsapp_messages set status = 'failed' where wamid = 'wamid.TEST28.1';
  select status into s from public.whatsapp_reminder_log where wamid = 'wamid.TEST28.1';
  if s <> 'read' then raise exception 'FAIL 3c: a late sent/failed callback regressed read to %', s; end if;
end $$;

-- ── 4. once per (subject, step) ────────────────────────────────────────────
do $$
begin
  begin
    insert into public.whatsapp_reminder_log (tenant_id, kind, subject_type, subject_id, step, status)
    values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_overdue', 'invoice', 'INV-T28-1', 'reminder', 'sent');
    raise exception 'FAIL 4a: the same step was logged as sent twice';
  exception when unique_violation then null;
  end;
  -- failed + skipped rows never block
  insert into public.whatsapp_reminder_log (tenant_id, kind, subject_type, subject_id, step, status, error_message)
  values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_overdue', 'invoice', 'INV-T28-2', 'retry', 'failed', 'x'),
         ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_overdue', 'invoice', 'INV-T28-2', 'retry', 'skipped', null);
  insert into public.whatsapp_reminder_log (tenant_id, kind, subject_type, subject_id, step, status)
  values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_overdue', 'invoice', 'INV-T28-2', 'retry', 'sent');
end $$;

-- ── 5. adopt a status that arrived first ───────────────────────────────────
do $$
declare s text; mid uuid;
begin
  update public.whatsapp_messages set status = 'delivered' where wamid = 'wamid.TEST28.2';
  insert into public.whatsapp_reminder_log (tenant_id, kind, subject_type, subject_id, step, wamid, status, sent_at)
  values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'renewal_upcoming', 'subscription', 'SUB-T28', 'notice_sent', 'wamid.TEST28.2', 'sent', now());
  select status, message_id into s, mid from public.whatsapp_reminder_log where wamid = 'wamid.TEST28.2';
  if s <> 'delivered' or mid is distinct from 'aaaaaaaa-0000-0000-0000-0000002800e2'::uuid then
    raise exception 'FAIL 5: late log row did not adopt delivered (status %, message %)', s, mid;
  end if;
end $$;

-- ── 1. owner can, sales cannot ─────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000028a0a1', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  insert into public.whatsapp_reminder_settings (tenant_id, enabled) values ('aaaaaaaa-0000-0000-0000-0000000028a1', true);
  insert into public.whatsapp_reminder_templates (tenant_id, kind, template_name, param_map)
  values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_overdue', 'invoice_overdue_v1', '["customer_name","invoice_id"]');
  select count(*) into n from public.whatsapp_reminder_log;
  if n < 3 then raise exception 'FAIL 1a: owner reads % log rows of their own', n; end if;
  begin
    insert into public.whatsapp_reminder_log (tenant_id, kind, subject_type, subject_id, step, status)
    values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_due', 'invoice', 'INV-FAKE', 'pre_due', 'sent');
    raise exception 'FAIL 1b: a browser user wrote a "sent" log row';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000028a0a2', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  update public.whatsapp_reminder_settings set enabled = false where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000028a1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 1c: a sales user flipped the reminder switch'; end if;
  select count(*) into n from public.whatsapp_reminder_settings where enabled;
  if n <> 1 then raise exception 'FAIL 1d: sales user cannot even read the switch (% rows)', n; end if;
end $$;

-- ── 2. other company ───────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000028b0b1', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select (select count(*) from public.whatsapp_reminder_settings)
       + (select count(*) from public.whatsapp_reminder_templates)
       + (select count(*) from public.whatsapp_reminder_log) into n;
  if n <> 0 then raise exception 'FAIL 2a: company B sees % reminder rows of company A', n; end if;
  update public.whatsapp_reminder_settings set enabled = false where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000028a1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2b: company B switched off company A''s reminders'; end if;
  begin
    insert into public.whatsapp_reminder_templates (tenant_id, kind, template_name)
    values ('aaaaaaaa-0000-0000-0000-0000000028a1', 'invoice_due', 'hijack');
    raise exception 'FAIL 2c: company B mapped a template for company A';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The zero above means something only if A's rows exist (L7).
reset role;
do $$
declare n int;
begin
  select count(*) into n from public.whatsapp_reminder_log where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000028a1';
  if n < 3 then raise exception 'FAIL 2d: precondition — A has only % log rows, the isolation check proved nothing', n; end if;
  if has_table_privilege('anon', 'public.whatsapp_reminder_log', 'select') then
    raise exception 'FAIL 2e: anon can select the reminder log';
  end if;
end $$;

select 'whatsapp_reminders: all assertions passed' as result;
rollback;
