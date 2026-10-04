-- Regression test: interns / trainees on a stipend (migration 20261004140000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/interns_stipend.test.sql
--
-- What it proves:
--   1. An intern's stipend is booked as 'Stipend — Interns & Trainees' ("Stipend 2026-10 — …").
--   2. An ordinary employee's pay still books as 'Salaries'.
--   3. An intern with PF switched on keeps the PF (no Apprentices-Act exclusion applies) and
--      the employer PF still books as 'PF — Employer'.
--   4. Training end before start is refused; an unknown type is refused.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000b7', 'INTERN TEST', 'intern@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000b7a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'intern-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000b7a1', 'aaaaaaaa-0000-0000-0000-0000000000b7', 'intern-owner@example.in', 'owner');
insert into public.employees (id, tenant_id, name, monthly_gross, engagement_type, training_start, training_end, training_area) values
  ('aaaaaaaa-0000-0000-0000-00000000b7e1', 'aaaaaaaa-0000-0000-0000-0000000000b7', 'Intern Isha', 8000, 'intern', '2026-09-01', '2027-02-28', 'Accounts');
insert into public.employees (id, tenant_id, name, monthly_gross, engagement_type, pf_applicable) values
  ('aaaaaaaa-0000-0000-0000-00000000b7e3', 'aaaaaaaa-0000-0000-0000-0000000000b7', 'Trainee Tarun', 15000, 'intern', true);
insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('aaaaaaaa-0000-0000-0000-00000000b7e2', 'aaaaaaaa-0000-0000-0000-0000000000b7', 'Staff Sunil', 25000);
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000000bb', 'aaaaaaaa-0000-0000-0000-0000000000b7', 'HDFC', 'HDFC', 0, '2026-04-01');

-- 4
do $$ begin
  begin
    update public.employees set training_end = '2026-08-01' where id = 'aaaaaaaa-0000-0000-0000-00000000b7e1';
    raise exception 'FAIL 4a: end before start accepted';
  exception when check_violation then null;
  end;
  begin
    update public.employees set engagement_type = 'consultant' where id = 'aaaaaaaa-0000-0000-0000-00000000b7e1';
    raise exception 'FAIL 4b: unknown type accepted';
  exception when check_violation then null;
  end;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000b7a1', 'role', 'authenticated')::text, true);

do $$
declare v_id uuid; v_exp public.expenses; v_pay public.salary_payments; n int;
begin
  -- 1
  v_id := public.pay_salary('aaaaaaaa-0000-0000-0000-00000000b7e1', '2026-10', '2026-10-31', 8000, 0, 0, 0, null, 0, 0, 0, 0,
                            'aaaaaaaa-0000-0000-0000-0000000000bb');
  select * into v_pay from public.salary_payments where id = v_id;
  select * into v_exp from public.expenses where id = v_pay.expense_id;
  if v_exp.category <> 'Stipend — Interns & Trainees' then raise exception 'FAIL 1: booked as %', v_exp.category; end if;
  if v_exp.description not like 'Stipend 2026-10 — Intern Isha%' then raise exception 'FAIL 1: description %', v_exp.description; end if;
  if v_pay.net <> 8000 then raise exception 'FAIL 1: net %', v_pay.net; end if;

  -- 2
  v_id := public.pay_salary('aaaaaaaa-0000-0000-0000-00000000b7e2', '2026-10', '2026-10-31', 25000, 0, 0, 0, null, 0, 0, 0, 0,
                            'aaaaaaaa-0000-0000-0000-0000000000bb');
  select * into v_pay from public.salary_payments where id = v_id;
  if (select category from public.expenses where id = v_pay.expense_id) <> 'Salaries' then
    raise exception 'FAIL 2: an employee''s salary was re-filed';
  end if;

  -- 3
  v_id := public.pay_salary('aaaaaaaa-0000-0000-0000-00000000b7e3', '2026-10', '2026-10-31', 15000, 0, 0, 0, null, 0, 1800, 0, 0,
                            'aaaaaaaa-0000-0000-0000-0000000000bb', null, 0, 0, 1800);
  select * into v_pay from public.salary_payments where id = v_id;
  if v_pay.pf <> 1800 then raise exception 'FAIL 3: intern PF dropped (%)', v_pay.pf; end if;
  if (select category from public.expenses where id = v_pay.expense_id) <> 'Stipend — Interns & Trainees' then raise exception 'FAIL 3: stipend not re-filed'; end if;
  select count(*) into n from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000b7' and category = 'PF — Employer';
  if n <> 1 then raise exception 'FAIL 3: employer PF rows %', n; end if;
end $$;

rollback;
