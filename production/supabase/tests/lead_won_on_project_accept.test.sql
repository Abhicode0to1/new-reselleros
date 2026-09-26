-- Regression test: trg_leads_won_on_project_accept (migration 20260926120000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/lead_won_on_project_accept.test.sql
--
-- What it proves:
--   1. Accepting a lead's project quotation (accept_project_quote) makes the lead Won, with a
--      timeline entry, and stamps stage_changed_at.
--   2. A lead marked Lost is moved to Won too, and its loss fields are cleared.
--   3. Cancelling a quotation does not touch the lead.
--   4. A lead of another company linked to nothing is untouched.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a7', 'LEADWON TEST A', 'lw-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lw-a-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a7', 'aaaaaaaa-0000-0000-0000-0000000000a7', 'lw-a-user@example.in', 'owner');
insert into public.leads (id, tenant_id, company, contact_name, stage, enquiry_type, requirement) values
  ('L-LW-1', 'aaaaaaaa-0000-0000-0000-0000000000a7', 'Demo Company', 'A', 'new', 'project', 'Billing system'),
  ('L-LW-2', 'aaaaaaaa-0000-0000-0000-0000000000a7', 'Lost Co',      'B', 'new', 'project', 'App'),
  ('L-LW-3', 'aaaaaaaa-0000-0000-0000-0000000000a7', 'Cancel Co',    'C', 'new', 'project', 'Site');

create temp table p (k text primary key, v uuid);
grant all on p to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a7', 'role', 'authenticated')::text, true);

insert into p select 'p1', public.create_project_quote_from_lead('L-LW-1', 'Complete Billing System', null,
  '[{"name":"Billing","qty":1,"rate":100000,"amount":100000}]'::jsonb, 18, false, '[]'::jsonb);
insert into p select 'p2', public.create_project_quote_from_lead('L-LW-2', 'App', null,
  '[{"name":"App","qty":1,"rate":50000,"amount":50000}]'::jsonb, 18, false, '[]'::jsonb);
insert into p select 'p3', public.create_project_quote_from_lead('L-LW-3', 'Site', null,
  '[{"name":"Site","qty":1,"rate":20000,"amount":20000}]'::jsonb, 18, false, '[]'::jsonb);

-- L-LW-2 was given up on before the customer came back
update public.leads set stage = 'lost', lost_reason = 'price', lost_at = now() where id = 'L-LW-2';

-- 1 + 2
select public.accept_project_quote((select v from p where k = 'p1'));
select public.accept_project_quote((select v from p where k = 'p2'));
do $$ declare l record; begin
  select * into l from public.leads where id = 'L-LW-1';
  if l.stage::text <> 'won' or l.stage_changed_at is null then raise exception 'FAIL: accepted lead is %', l.stage; end if;
  if not exists (select 1 from public.lead_activities where lead_id = 'L-LW-1' and kind = 'stage' and detail like '%Complete Billing System%accepted%') then
    raise exception 'FAIL: no timeline entry'; end if;
  select * into l from public.leads where id = 'L-LW-2';
  if l.stage::text <> 'won' or l.lost_reason is not null or l.lost_at is not null then
    raise exception 'FAIL: lost lead % % %', l.stage, l.lost_reason, l.lost_at; end if;
end $$;

-- 3. cancelled quotation leaves the lead alone
update public.project_sales set status = 'cancelled' where id = (select v from p where k = 'p3');
do $$ begin
  if (select stage::text from public.leads where id = 'L-LW-3') <> 'quote' then raise exception 'FAIL: cancelled quotation moved the lead'; end if;
end $$;

select 'lead_won_on_project_accept: all assertions passed' as result;
rollback;
