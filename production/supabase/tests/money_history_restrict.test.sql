-- Regression test: employee / bank account delete keeps money history (migration 20260927110000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/money_history_restrict.test.sql
--
-- What it proves:
--   1. An employee with a salary payment cannot be deleted; the message says why.
--   2. An employee with nothing paid can still be deleted.
--   3. A bank account with statement lines cannot be deleted (trigger AND the RPC); an empty one can.
--   4. The salary row and the bank lines are still there afterwards.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000f7', 'RESTRICT A', 'rs-a@example.in', '07');
insert into public.employees (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-00000000e1f7', 'aaaaaaaa-0000-0000-0000-0000000000f7', 'Paid Person'),
  ('aaaaaaaa-0000-0000-0000-00000000e2f7', 'aaaaaaaa-0000-0000-0000-0000000000f7', 'Never Paid');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-00000000a1f7', 'aaaaaaaa-0000-0000-0000-0000000000f7', 'Used HDFC', 'HDFC', 0, '2026-04-01'),
  ('aaaaaaaa-0000-0000-0000-00000000a2f7', 'aaaaaaaa-0000-0000-0000-0000000000f7', 'Empty SBI', 'SBI', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-00000000b1f7', 'aaaaaaaa-0000-0000-0000-0000000000f7', 'aaaaaaaa-0000-0000-0000-00000000a1f7', '2026-08-01', 'SALARY', 25000, 0, 'manual');
insert into public.salary_payments (tenant_id, employee_id, period, gross, net, pay_date, paid_status)
  values ('aaaaaaaa-0000-0000-0000-0000000000f7', 'aaaaaaaa-0000-0000-0000-00000000e1f7', '2026-08', 30000, 25000, '2026-08-01', 'paid');

do $$
declare n int; v_msg text;
begin
  -- 1
  begin
    delete from public.employees where id = 'aaaaaaaa-0000-0000-0000-00000000e1f7';
    raise exception 'FAIL 1: employee with payroll history was deleted';
  exception when foreign_key_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%1 salary%' then raise exception 'FAIL 1b: unhelpful message: %', v_msg; end if;
  end;
  -- 2
  delete from public.employees where id = 'aaaaaaaa-0000-0000-0000-00000000e2f7';
  select count(*) into n from public.employees where id = 'aaaaaaaa-0000-0000-0000-00000000e2f7';
  if n <> 0 then raise exception 'FAIL 2: unpaid employee could not be deleted'; end if;
  -- 3
  begin
    delete from public.bank_accounts where id = 'aaaaaaaa-0000-0000-0000-00000000a1f7';
    raise exception 'FAIL 3a: bank account with lines was deleted';
  exception when foreign_key_violation then null;
  end;
  delete from public.bank_accounts where id = 'aaaaaaaa-0000-0000-0000-00000000a2f7';
  select count(*) into n from public.bank_accounts where id = 'aaaaaaaa-0000-0000-0000-00000000a2f7';
  if n <> 0 then raise exception 'FAIL 3b: empty bank account could not be deleted'; end if;
  -- 4
  select count(*) into n from public.salary_payments where employee_id = 'aaaaaaaa-0000-0000-0000-00000000e1f7';
  if n <> 1 then raise exception 'FAIL 4a: salary row gone'; end if;
  select count(*) into n from public.bank_transactions where bank_account_id = 'aaaaaaaa-0000-0000-0000-00000000a1f7';
  if n <> 1 then raise exception 'FAIL 4b: bank line gone'; end if;
end $$;

-- 3 again through the RPC, as the owner
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000f7a7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rs-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000f7a7', 'aaaaaaaa-0000-0000-0000-0000000000f7', 'rs-owner@example.in', 'owner');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000f7a7', 'role', 'authenticated')::text, true);
do $$ begin
  begin
    perform public.delete_bank_account('aaaaaaaa-0000-0000-0000-00000000a1f7');
    raise exception 'FAIL 3c: RPC deleted a bank account with lines';
  exception when foreign_key_violation then null;
  end;
end $$;

select 'money_history_restrict: all assertions passed' as result;
rollback;
