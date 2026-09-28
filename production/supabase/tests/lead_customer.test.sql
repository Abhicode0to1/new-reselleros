-- Regression test: leads.customer_id (migration 20260926250000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/lead_customer.test.sql
--
-- What it proves:
--   1. A lead can be linked to the company's own existing customer.
--   2. It cannot be linked to another company's customer, even by typing the id.
--   3. Deleting the customer keeps the lead, unlinked.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000d4', 'LC TEST A', 'lc-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000d4', 'LC TEST B', 'lc-b@example.in', '07');
insert into public.customers (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000c0d4', 'aaaaaaaa-0000-0000-0000-0000000000d4', 'Excel A'),
  ('bbbbbbbb-0000-0000-0000-00000000c0d4', 'bbbbbbbb-0000-0000-0000-0000000000d4', 'Other B');

do $$
declare v uuid;
begin
  -- 1
  insert into public.leads (id, tenant_id, company, stage, customer_id)
  values ('L-LCTEST-1', 'aaaaaaaa-0000-0000-0000-0000000000d4', 'Excel A', 'new', 'aaaaaaaa-0000-0000-0000-00000000c0d4');

  -- 2
  begin
    update public.leads set customer_id = 'bbbbbbbb-0000-0000-0000-00000000c0d4' where id = 'L-LCTEST-1';
    raise exception 'FAIL 2: lead linked to another company''s customer';
  exception when others then
    if sqlerrm not like 'Customer not found%' then raise; end if;
  end;

  -- 3
  delete from public.customers where id = 'aaaaaaaa-0000-0000-0000-00000000c0d4';
  select customer_id into v from public.leads where id = 'L-LCTEST-1';
  if not found then raise exception 'FAIL 3a: lead deleted with the customer'; end if;
  if v is not null then raise exception 'FAIL 3b: lead still points at a deleted customer'; end if;
end $$;

select 'lead_customer: all assertions passed' as result;
rollback;
