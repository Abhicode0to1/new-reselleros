-- Regression test: edit / delete an employee advance (migration 20261004130000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/employee_advance_edit_delete.test.sql
--
-- What it proves:
--   1. Editing an open advance changes name, amount, date AND the petty-cash disbursal line.
--   2. The amount cannot drop below what is already spent.
--   3. Delete is refused while an expense is booked against it, and changes nothing.
--   4. Delete with expenses: removes the expense, every cash line it wrote (disbursal +
--      top-up) and the advance; petty cash is back where it started.
--   5. A bank statement line matched to an advance is un-matched, never deleted.
--   6. A sales user cannot edit or delete.
--   7. Editing the purpose keeps the top-up / settle history lines in notes.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'ADV ED TEST', 'adv-ed@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000f0f1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'adv-ed-owner@example.in'),
  ('aaaaaaaa-0000-0000-0000-00000000f0f2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'adv-ed-sales@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000f0f1', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'adv-ed-owner@example.in', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000f0f2', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'adv-ed-sales@example.in', 'sales');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000fc001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'Petty cash', 'Cash', 'cash', 10000, '2026-04-01'),
  ('aaaaaaaa-0000-0000-0000-0000000fb001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'HDFC', 'HDFC', 'current', 0, '2026-04-01');

create temp table t_ids (k text primary key, v text);
grant all on t_ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000f0f1', 'role', 'authenticated')::text, true);

-- 1. Give ₹5,000 from petty cash, then edit it to ₹4,000, new name and date.
do $$
declare v_id uuid; v_adv public.prepaid_advances; v_line public.bank_transactions;
begin
  v_id := public.give_employee_advance('Ramu typo', 5000, '2026-10-01', 'cash', 'aaaaaaaa-0000-0000-0000-0000000fc001', 'Float');
  insert into t_ids values ('adv', v_id::text);
  perform public.update_employee_advance(v_id, 'Ramu Kumar', 4000, '2026-10-02', 'Weekly float');
  select * into v_adv from public.prepaid_advances where id = v_id;
  if v_adv.vendor_name <> 'Ramu Kumar' or v_adv.total_amount <> 4000 or v_adv.paid_date <> '2026-10-02' then
    raise exception 'FAIL 1: advance not edited: % % %', v_adv.vendor_name, v_adv.total_amount, v_adv.paid_date;
  end if;
  select * into v_line from public.bank_transactions where id = v_adv.bank_txn_id;
  if v_line.debit <> 4000 or v_line.txn_date <> '2026-10-02' or v_line.description <> 'Advance to Ramu Kumar' then
    raise exception 'FAIL 1: cash line not kept in step: % % %', v_line.debit, v_line.txn_date, v_line.description;
  end if;
end $$;

-- 2. Spend ₹300, then try to cut the amount to ₹200.
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv');
begin
  insert into public.expenses (id, tenant_id, category, vendor_name, amount, expense_date, payment_method, prepaid_advance_id, attachment_url)
  values ('EXP-ADVED1', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'Staff Welfare', 'Tea', 300, '2026-10-02',
          'employee_advance', v_adv, 'bills/t.jpg');
  begin
    perform public.update_employee_advance(v_adv, 'Ramu Kumar', 200, '2026-10-02', null);
    raise exception 'FAIL 2: amount below spent was allowed';
  exception when others then
    if sqlerrm not like '%already spent%' then raise exception 'FAIL 2: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- 3. Delete without consent to drop the expense is refused and changes nothing.
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv');
begin
  begin
    perform public.delete_employee_advance(v_adv);
    raise exception 'FAIL 3: delete with a booked expense was allowed';
  exception when others then
    if sqlerrm not like '%booked against this advance%' then raise exception 'FAIL 3: wrong refusal: %', sqlerrm; end if;
  end;
  if not exists (select 1 from public.prepaid_advances where id = v_adv) then raise exception 'FAIL 3: advance gone'; end if;
  if not exists (select 1 from public.expenses where id = 'EXP-ADVED1') then raise exception 'FAIL 3: expense gone'; end if;
end $$;

-- 6. A sales user can neither edit nor delete.
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000f0f2', 'role', 'authenticated')::text, true);
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv');
begin
  begin
    perform public.update_employee_advance(v_adv, 'Hacked', 4000, '2026-10-02', null);
    raise exception 'FAIL 6: sales edited an advance';
  exception when others then
    if sqlerrm not like 'Only an owner%' then raise exception 'FAIL 6: wrong refusal (edit): %', sqlerrm; end if;
  end;
  begin
    perform public.delete_employee_advance(v_adv, true);
    raise exception 'FAIL 6: sales deleted an advance';
  exception when others then
    if sqlerrm not like 'Only an owner%' then raise exception 'FAIL 6: wrong refusal (delete): %', sqlerrm; end if;
  end;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000f0f1', 'role', 'authenticated')::text, true);

-- 7. Top up ₹1,000, edit the purpose: history line survives, amount edit now refused.
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv'); v_notes text;
begin
  perform public.top_up_employee_advance(v_adv, 1000, '2026-10-03', null);
  perform public.update_employee_advance(v_adv, 'Ramu Kumar', 5000, '2026-10-02', 'Office float');
  select notes into v_notes from public.prepaid_advances where id = v_adv;
  if v_notes not like 'Office float' || chr(10) || 'Top-up ₹1000 on%' then raise exception 'FAIL 7: notes now %', v_notes; end if;
  begin
    perform public.update_employee_advance(v_adv, 'Ramu Kumar', 6000, '2026-10-02', 'Office float');
    raise exception 'FAIL 7: amount edit after a top-up was allowed';
  exception when others then
    if sqlerrm not like '%has a top-up%' then raise exception 'FAIL 7: wrong refusal: %', sqlerrm; end if;
  end;
end $$;

-- 4. Delete with expenses with expenses: everything it wrote is gone.
do $$
declare v_adv uuid := (select v::uuid from t_ids where k = 'adv'); v_res jsonb; v_left int;
begin
  v_res := public.delete_employee_advance(v_adv, true);
  if (v_res->>'expenses_deleted')::int <> 1 or (v_res->>'cash_lines_deleted')::int <> 2 then
    raise exception 'FAIL 4: unexpected result %', v_res;
  end if;
  if exists (select 1 from public.prepaid_advances where id = v_adv) then raise exception 'FAIL 4: advance still there'; end if;
  if exists (select 1 from public.expenses where id = 'EXP-ADVED1') then raise exception 'FAIL 4: expense still there'; end if;
  select count(*) into v_left from public.bank_transactions where matched_to_id = v_adv::text;
  if v_left <> 0 then raise exception 'FAIL 4: % cash line(s) left behind', v_left; end if;
end $$;

-- 5. A bank statement line matched to an advance is only un-matched.
reset role;
insert into public.prepaid_advances (id, tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method, bank_account_id)
values ('aaaaaaaa-0000-0000-0000-0000000fa005', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'Shyam', 'Employee advance', 2000, 0, '2026-10-01', 'upi', 'aaaaaaaa-0000-0000-0000-0000000fb001');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id)
values ('aaaaaaaa-0000-0000-0000-0000000fd005', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000fb001', '2026-10-01', 'UPI/SHYAM', 2000, 0, 'csv_upload', 'prepaid', 'aaaaaaaa-0000-0000-0000-0000000fa005');
set local role authenticated;
do $$
declare v_line public.bank_transactions;
begin
  perform public.delete_employee_advance('aaaaaaaa-0000-0000-0000-0000000fa005');
  select * into v_line from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000fd005';
  if not found then raise exception 'FAIL 5: statement line was deleted'; end if;
  if v_line.matched_to_type is not null then raise exception 'FAIL 5: statement line still matched'; end if;
end $$;

rollback;
