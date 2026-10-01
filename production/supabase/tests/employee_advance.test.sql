-- Regression test: staff / peon advances (migration 20261001150000, R-101).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/employee_advance.test.sql
--
-- What it proves:
--   1. Giving ₹5,000 from petty cash makes an advance (asset), NOT an expense, and takes
--      ₹5,000 out of the petty-cash account.
--   2. A ₹200 spend written as an ordinary expense (payment_method employee_advance) saves —
--      this is what failed before with the FK error — and leaves ₹4,800.
--   3. More than what is left is refused, and changes nothing.
--   4. Deleting the spend gives the ₹200 back; editing its amount re-checks it.
--   5. Another company's advance cannot be spent from.
--   6. Top-up adds to the same advance; settle returns the rest to petty cash and closes it,
--      after which spending is refused.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'ADV TEST A', 'adv-a@example.in', '07'),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'ADV TEST B', 'adv-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e0e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'adv-a-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000e0e1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'adv-a-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ec001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Petty cash', 'Cash', 'cash', 10000, '2026-04-01');
-- Company B's advance, made directly (we are postgres here)
insert into public.prepaid_advances (id, tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date) values
  ('aaaaaaaa-0000-0000-0000-0000000eb001', 'aaaaaaaa-0000-0000-0000-0000000000e2', 'Other peon', 'Employee advance', 9000, 0, '2026-09-01');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000e0e1', 'role', 'authenticated')::text, true);

create temp table t_ids (k text primary key, v text);
grant all on t_ids to authenticated;

-- 1. Give
do $$
declare v_id uuid; v_n int; v_cash int;
begin
  v_id := public.give_employee_advance('AITEST Ramu', 5000, '2026-10-01', 'cash', 'aaaaaaaa-0000-0000-0000-0000000ec001', 'Weekly float');
  insert into t_ids values ('adv', v_id::text);
  select count(*) into v_n from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e1';
  if v_n <> 0 then raise exception 'FAIL 1: the advance was booked as % expense row(s)', v_n; end if;
  select coalesce(sum(debit), 0) into v_cash from public.bank_transactions
   where bank_account_id = 'aaaaaaaa-0000-0000-0000-0000000ec001' and matched_to_id = v_id::text;
  if v_cash <> 5000 then raise exception 'FAIL 1: petty cash out %', v_cash; end if;
end $$;

-- 2. Spend ₹200 through an ordinary expense row
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv'); v_used int;
begin
  insert into public.expenses (id, tenant_id, category, vendor_name, amount, expense_date, payment_method, prepaid_advance_id, attachment_url)
  values ('EXP-ADVTEST1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Staff Welfare', 'Sharma Tea Stall', 200, '2026-10-01',
          'employee_advance', v_adv, 'bills/chai.jpg');
  select consumed_amount into v_used from public.prepaid_advances where id = v_adv;
  if v_used <> 200 then raise exception 'FAIL 2: consumed %', v_used; end if;
  if not (select paid from public.expenses where id = 'EXP-ADVTEST1') then raise exception 'FAIL 2: spend not marked paid'; end if;
end $$;

-- 3. Over the balance is refused
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv'); v_used int;
begin
  begin
    insert into public.expenses (id, tenant_id, category, amount, expense_date, payment_method, prepaid_advance_id)
    values ('EXP-ADVTEST2', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Travel', 4801, '2026-10-01', 'employee_advance', v_adv);
    raise exception 'FAIL 3: ₹4,801 accepted with ₹4,800 left';
  exception when check_violation then null;
  end;
  select consumed_amount into v_used from public.prepaid_advances where id = v_adv;
  if v_used <> 200 then raise exception 'FAIL 3: consumed moved to %', v_used; end if;
end $$;

-- 4. Edit re-checks; delete gives it back
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv'); v_used int;
begin
  update public.expenses set amount = 300 where id = 'EXP-ADVTEST1';
  select consumed_amount into v_used from public.prepaid_advances where id = v_adv;
  if v_used <> 300 then raise exception 'FAIL 4: after edit consumed %', v_used; end if;
  delete from public.expenses where id = 'EXP-ADVTEST1';
  select consumed_amount into v_used from public.prepaid_advances where id = v_adv;
  if v_used <> 0 then raise exception 'FAIL 4: after delete consumed %', v_used; end if;
end $$;

-- 5. Another company's advance
do $$
begin
  begin
    insert into public.expenses (id, tenant_id, category, amount, expense_date, payment_method, prepaid_advance_id)
    values ('EXP-ADVTEST3', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Travel', 100, '2026-10-01', 'employee_advance',
            'aaaaaaaa-0000-0000-0000-0000000eb001');
    raise exception 'FAIL 5: spent from another company''s advance';
  exception when check_violation then null;
  end;
end $$;

-- 6. Top-up, settle, then spending is refused
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv'); v_left int; v_back int; v_ret int; v_total int;
begin
  insert into public.expenses (id, tenant_id, category, amount, expense_date, payment_method, prepaid_advance_id)
  values ('EXP-ADVTEST4', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Travel', 1000, '2026-10-02', 'employee_advance', v_adv);
  v_left := public.top_up_employee_advance(v_adv, 1000, '2026-10-03', null);
  if v_left <> 5000 then raise exception 'FAIL 6: after top-up left %', v_left; end if;

  v_ret := public.settle_employee_advance(v_adv, '2026-10-05', null);
  if v_ret <> 5000 then raise exception 'FAIL 6: returned %', v_ret; end if;
  select coalesce(sum(credit), 0) into v_back from public.bank_transactions
   where bank_account_id = 'aaaaaaaa-0000-0000-0000-0000000ec001' and matched_to_id = v_adv::text;
  if v_back <> 5000 then raise exception 'FAIL 6: petty cash back %', v_back; end if;
  select total_amount into v_total from public.prepaid_advances where id = v_adv;
  if v_total <> 1000 then raise exception 'FAIL 6: settled advance still holds %', v_total; end if;

  begin
    insert into public.expenses (id, tenant_id, category, amount, expense_date, payment_method, prepaid_advance_id)
    values ('EXP-ADVTEST5', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'Travel', 1, '2026-10-06', 'employee_advance', v_adv);
    raise exception 'FAIL 6: spent from a settled advance';
  exception when check_violation then null;
  end;
end $$;

rollback;
\echo 'employee_advance: all checks passed'
