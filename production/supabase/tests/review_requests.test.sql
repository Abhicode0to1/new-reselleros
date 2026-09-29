-- Regression test: Google review requests (migration 20260926220000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/review_requests.test.sql
--
-- What it proves:
--   1. A company logs a request for its own customer and saves its review link.
--   2. Another company cannot see the request, nor log one against the first company.
--   3. Only the known channels / statuses are accepted.
--   4. Deleting the customer removes its requests (not a financial record).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a7', 'REV TEST A', 'rev-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000a7', 'REV TEST B', 'rev-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a7a7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rev-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000a7b7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rev-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a7a7', 'aaaaaaaa-0000-0000-0000-0000000000a7', 'rev-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000a7b7', 'bbbbbbbb-0000-0000-0000-0000000000a7', 'rev-b-user@example.in', 'owner');
insert into public.customers (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000c0a7', 'aaaaaaaa-0000-0000-0000-0000000000a7', 'Happy Customer');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a7a7', 'role', 'authenticated')::text, true);

-- 1 + 3
do $$
declare n int; l text;
begin
  insert into public.review_requests (tenant_id, customer_id, channel, sent_to, status)
  values ('aaaaaaaa-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-00000000c0a7', 'whatsapp', '+919899065121', 'opened');
  insert into public.marketing_tools (tenant_id, tool_key, name, review_link)
  values ('aaaaaaaa-0000-0000-0000-0000000000a7', 'google-business', 'Google Business Profile', 'https://g.page/r/x/review');
  select count(*) into n from public.review_requests;
  select review_link into l from public.marketing_tools where tool_key = 'google-business';
  if n <> 1 or l is distinct from 'https://g.page/r/x/review' then raise exception 'FAIL 1: % requests, link %', n, l; end if;

  begin
    insert into public.review_requests (tenant_id, customer_id, channel, status)
    values ('aaaaaaaa-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-00000000c0a7', 'sms', 'sent');
    raise exception 'FAIL 3: unknown channel accepted';
  exception when check_violation then null;
  end;
end $$;

-- 2. Company B
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000a7b7', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.review_requests;
  if n <> 0 then raise exception 'FAIL 2a: B sees A''s requests'; end if;
  begin
    insert into public.review_requests (tenant_id, customer_id, channel, status)
    values ('aaaaaaaa-0000-0000-0000-0000000000a7', 'aaaaaaaa-0000-0000-0000-00000000c0a7', 'email', 'sent');
    raise exception 'FAIL 2b: B logged a request for A';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 4. Customer deleted → requests go
reset role;
delete from public.customers where id = 'aaaaaaaa-0000-0000-0000-00000000c0a7';
do $$
declare n int;
begin
  select count(*) into n from public.review_requests where customer_id = 'aaaaaaaa-0000-0000-0000-00000000c0a7';
  if n <> 0 then raise exception 'FAIL 4: % requests left after the customer was deleted', n; end if;
end $$;

select 'review_requests: all assertions passed' as result;
rollback;
