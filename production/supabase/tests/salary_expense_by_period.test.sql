-- Regression test: salary expense dated in the salary month (migration 20260927170000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/salary_expense_by_period.test.sql
--
-- What it proves:
--   1. August salary paid on 3 September → Salaries, employer PF and employer ESI
--      expenses all dated 31 August; the salary row keeps pay_date 3 September.
--   2. September salary paid on 26 September → dated 26 September (inside the month).
--   3. salary_expense_date() itself, including a leap February.
--   4. A malformed period is refused.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000c2', 'ACCRUAL A', 'ac-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000c2a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ac-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000c2a1', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'ac-owner@example.in', 'owner');
insert into public.employees (id, tenant_id, name, monthly_gross, pf_applicable, esi_applicable) values
  ('aaaaaaaa-0000-0000-0000-00000000c2e1', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'Accrual Person', 20000, true, true);
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-00000000ac2b', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'HDFC', 'HDFC', 0, '2026-04-01');

-- 3
do $$ begin
  if public.salary_expense_date('2026-08', '2026-09-03') <> '2026-08-31' then raise exception 'FAIL 3a'; end if;
  if public.salary_expense_date('2026-09', '2026-09-26') <> '2026-09-26' then raise exception 'FAIL 3b'; end if;
  if public.salary_expense_date('2028-02', '2028-03-05') <> '2028-02-29' then raise exception 'FAIL 3c: leap February'; end if;
  if public.salary_expense_date('2026-10', '2026-09-28') <> '2026-10-31' then raise exception 'FAIL 3d: paid early, still the salary month'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000c2a1', 'role', 'authenticated')::text, true);

do $$
declare v_id uuid; v_exp text; n int;
begin
  -- 1
  v_id := public.pay_salary('aaaaaaaa-0000-0000-0000-00000000c2e1', '2026-08', '2026-09-03', 20000, 0, 0, 0, null, 0, 1800, 150, 0,
                            'aaaaaaaa-0000-0000-0000-00000000ac2b', null, 0, 650, 1800);
  select expense_id into v_exp from public.salary_payments where id = v_id;
  if (select expense_date from public.expenses where id = v_exp) <> '2026-08-31' then raise exception 'FAIL 1a: salary expense not in August'; end if;
  if (select pay_date from public.salary_payments where id = v_id) <> '2026-09-03' then raise exception 'FAIL 1b: pay date changed'; end if;
  select count(*) into n from public.expenses
   where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000c2' and payment_method = 'statutory' and expense_date = '2026-08-31';
  if n <> 2 then raise exception 'FAIL 1c: employer PF/ESI expenses not in August (%)', n; end if;

  -- 2
  v_id := public.pay_salary('aaaaaaaa-0000-0000-0000-00000000c2e1', '2026-09', '2026-09-26', 20000, 0, 0, 0, null, 0, 1800, 150, 0,
                            'aaaaaaaa-0000-0000-0000-00000000ac2b');
  select expense_id into v_exp from public.salary_payments where id = v_id;
  if (select expense_date from public.expenses where id = v_exp) <> '2026-09-26' then raise exception 'FAIL 2: paid inside the month should keep the pay date'; end if;

  -- 4
  begin
    perform public.pay_salary('aaaaaaaa-0000-0000-0000-00000000c2e1', 'Sep 2026', '2026-09-26', 20000, 0, 0, 0, null, 0, 0, 0, 0,
                              'aaaaaaaa-0000-0000-0000-00000000ac2b');
    raise exception 'FAIL 4: malformed period accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;
end $$;

select 'salary_expense_by_period: all assertions passed' as result;
rollback;
