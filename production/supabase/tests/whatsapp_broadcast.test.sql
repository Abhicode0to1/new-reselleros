-- Regression test: WhatsApp broadcast tables (migration 20260926230000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/whatsapp_broadcast.test.sql
--
-- What it proves:
--   1. A company keeps its own templates; a name Meta would reject is refused.
--   2. Opt-outs are stored only as +digits; the same number once per company.
--   3. A signed-in user cannot write a broadcast record (only the server route can), but
--      can read their own company's.
--   4. Another company sees none of it and cannot write into it.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000b8', 'WA TEST A', 'wa-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b8', 'WA TEST B', 'wa-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000b8a8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wa-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b8b8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wa-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000b8a8', 'aaaaaaaa-0000-0000-0000-0000000000b8', 'wa-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b8b8', 'bbbbbbbb-0000-0000-0000-0000000000b8', 'wa-b-user@example.in', 'owner');

-- The server route (service role) records one broadcast for A.
insert into public.whatsapp_broadcasts (tenant_id, template_name, recipients_count, sent_count)
values ('aaaaaaaa-0000-0000-0000-0000000000b8', 'festival_offer', 10, 9);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000b8a8', 'role', 'authenticated')::text, true);

do $$
declare n int;
begin
  -- 1
  insert into public.whatsapp_templates (tenant_id, name, body, param_map, status)
  values ('aaaaaaaa-0000-0000-0000-0000000000b8', 'festival_offer', 'Hi {{1}}', '["first_name"]', 'approved');
  begin
    insert into public.whatsapp_templates (tenant_id, name, body) values ('aaaaaaaa-0000-0000-0000-0000000000b8', 'Festival Offer', 'x');
    raise exception 'FAIL 1: bad template name accepted';
  exception when check_violation then null;
  end;

  -- 2
  insert into public.whatsapp_opt_outs (tenant_id, phone, reason) values ('aaaaaaaa-0000-0000-0000-0000000000b8', '+919899065121', 'stop');
  begin
    insert into public.whatsapp_opt_outs (tenant_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000b8', '98990 65121');
    raise exception 'FAIL 2a: unnormalised phone accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.whatsapp_opt_outs (tenant_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000b8', '+919899065121');
    raise exception 'FAIL 2b: same number twice';
  exception when unique_violation then null;
  end;

  -- 3
  select count(*) into n from public.whatsapp_broadcasts;
  if n <> 1 then raise exception 'FAIL 3a: A sees % broadcasts', n; end if;
  begin
    insert into public.whatsapp_broadcasts (tenant_id, template_name, recipients_count, sent_count)
    values ('aaaaaaaa-0000-0000-0000-0000000000b8', 'fake', 500, 500);
    raise exception 'FAIL 3b: a browser wrote a broadcast record';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 4
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b8b8', 'role', 'authenticated')::text, true);
do $$
declare t int; o int; b int;
begin
  select count(*) into t from public.whatsapp_templates;
  select count(*) into o from public.whatsapp_opt_outs;
  select count(*) into b from public.whatsapp_broadcasts;
  if t + o + b <> 0 then raise exception 'FAIL 4a: B sees templates %, opt-outs %, broadcasts %', t, o, b; end if;
  begin
    insert into public.whatsapp_opt_outs (tenant_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000b8', '+911111111111');
    raise exception 'FAIL 4b: B wrote into A';
  exception when insufficient_privilege then null;
  end;
end $$;

select 'whatsapp_broadcast: all assertions passed' as result;
rollback;
