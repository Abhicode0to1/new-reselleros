-- R-163 (5 Oct 2026): payment runs — who may create / approve / mark paid, and the refusals
-- that stop a double payment.
--
-- Self-asserting, rolled back. Refusals are matched on the functions' own wording, never on
-- "nothing changed" (which would also pass if RLS simply hid the row).
begin;

-- Fixtures: one tenant with owner / manager / billing / sales, plus a stranger tenant.
insert into auth.users (id, instance_id, aud, role, email) values
  ('a1630000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr-owner@test.invalid'),
  ('a1630000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr-manager@test.invalid'),
  ('a1630000-0000-0000-0000-00000000000c','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr-billing@test.invalid'),
  ('a1630000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr-sales@test.invalid'),
  ('a1630000-0000-0000-0000-00000000000e','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pr-stranger@test.invalid')
on conflict (id) do nothing;

insert into public.tenants (id, name, email) values
  ('b1630000-0000-0000-0000-000000000001','PR Test Co','pr@test.invalid'),
  ('b1630000-0000-0000-0000-000000000002','PR Other Co','pr-other@test.invalid')
on conflict (id) do nothing;

insert into public.users (id, tenant_id, email, role) values
  ('a1630000-0000-0000-0000-00000000000a','b1630000-0000-0000-0000-000000000001','pr-owner@test.invalid','owner'),
  ('a1630000-0000-0000-0000-00000000000b','b1630000-0000-0000-0000-000000000001','pr-manager@test.invalid','manager'),
  ('a1630000-0000-0000-0000-00000000000c','b1630000-0000-0000-0000-000000000001','pr-billing@test.invalid','billing'),
  ('a1630000-0000-0000-0000-00000000000d','b1630000-0000-0000-0000-000000000001','pr-sales@test.invalid','sales'),
  ('a1630000-0000-0000-0000-00000000000e','b1630000-0000-0000-0000-000000000002','pr-stranger@test.invalid','owner')
on conflict (id) do nothing;

insert into public.bank_accounts (id, tenant_id, name, bank_name)
values ('c1630000-0000-0000-0000-000000000001','b1630000-0000-0000-0000-000000000001','Current A/c','HDFC Bank');

insert into public.vendors (id, tenant_id, name, bank_account_name, bank_account_no, bank_ifsc)
values ('d1630000-0000-0000-0000-000000000001','b1630000-0000-0000-0000-000000000001','Redington','Redington India Ltd','50200012345678','HDFC0001234');

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, total, paid_amount, status) values
  ('VB-PR-1','b1630000-0000-0000-0000-000000000001','d1630000-0000-0000-0000-000000000001','Redington','R/101', current_date - 20, 10000, 0, 'unpaid'),
  ('VB-PR-2','b1630000-0000-0000-0000-000000000001','d1630000-0000-0000-0000-000000000001','Redington','R/102', current_date - 10,  5000, 0, 'unpaid');
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, total, paid_amount, status, currency, fx_rate)
values ('VB-PR-USD','b1630000-0000-0000-0000-000000000001','AWS','AWS-1', current_date - 3, 120, 0, 'unpaid', 'USD', 84);
insert into public.expenses (id, tenant_id, category, vendor_name, amount, expense_date, paid)
values ('EXP-PR-1','b1630000-0000-0000-0000-000000000001','software','Zoho', 2000, current_date - 5, false);

-- 0. Bank details are checked at the door.
do $$
declare v_err text;
begin
  begin
    update public.vendors set bank_ifsc = 'hdfc123' where id = 'd1630000-0000-0000-0000-000000000001';
  exception when check_violation then v_err := sqlerrm; end;
  if v_err is null or v_err not like '%vendors_bank_ifsc_format%' then raise exception 'FAIL: a malformed IFSC was accepted (%)', v_err; end if;
  raise notice 'PASS: malformed IFSC refused';

  -- A real UPI id saves (the first version's pattern used {2,256}: Postgres caps a
  -- repetition at 255, so EVERY vendor with a UPI id failed to save).
  update public.vendors set upi_id = 'ravi.k@okicici' where id = 'd1630000-0000-0000-0000-000000000001';
  v_err := null;
  begin
    update public.vendors set upi_id = 'ravi@' where id = 'd1630000-0000-0000-0000-000000000001';
  exception when check_violation then v_err := sqlerrm; end;
  if v_err is null or v_err not like '%vendors_upi_id_format%' then raise exception 'FAIL: malformed UPI accepted (%)', v_err; end if;
  update public.vendors set upi_id = null where id = 'd1630000-0000-0000-0000-000000000001';
  raise notice 'PASS: a UPI id saves, a malformed one is refused';
end $$;

create or replace function pg_temp.act_as(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

set local role authenticated;

-- 1. Sales may not create a run; billing may.
do $$
declare v_err text; v_run uuid; v_total bigint; v_no text; v_n int;
begin
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000d');
  begin
    perform public.create_payment_run('[{"source":"vendor_bill","doc_id":"VB-PR-1","amount":10000}]'::jsonb, 'c1630000-0000-0000-0000-000000000001');
  exception when insufficient_privilege then v_err := sqlerrm; end;
  if v_err is null or v_err not like 'Only owner, manager, billing or accountant can create%' then raise exception 'FAIL: sales created a run (%)', v_err; end if;
  raise notice 'PASS: sales cannot create a payment run';

  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000c');
  v_run := public.create_payment_run(
    '[{"source":"vendor_bill","doc_id":"VB-PR-1","amount":10000},{"source":"expense","doc_id":"EXP-PR-1","amount":2000}]'::jsonb,
    'c1630000-0000-0000-0000-000000000001', current_date, 'Week 41');
  select total, run_no into v_total, v_no from public.payment_runs where id = v_run;
  select count(*) into v_n from public.payment_run_items where run_id = v_run;
  if v_total <> 12000 or v_n <> 2 or v_no not like 'PR-______-001' then raise exception 'FAIL: run total %, items %, no %', v_total, v_n, v_no; end if;
  perform set_config('pr.run1', v_run::text, true);
  raise notice 'PASS: billing creates a run — ₹12,000, 2 items, %', v_no;
end $$;

-- 2. The same bill cannot sit in two open runs; nor can more than is owed be paid.
do $$
declare v_err text;
begin
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000b');
  begin
    perform public.create_payment_run('[{"source":"vendor_bill","doc_id":"VB-PR-1","amount":500}]'::jsonb, 'c1630000-0000-0000-0000-000000000001');
  exception when others then v_err := sqlerrm; end;
  if v_err is null or v_err not like '%already in another open payment run%' then raise exception 'FAIL: a bill went into two open runs (%)', v_err; end if;
  raise notice 'PASS: one bill, one open run';

  v_err := null;
  begin
    perform public.create_payment_run('[{"source":"vendor_bill","doc_id":"VB-PR-2","amount":5001}]'::jsonb, 'c1630000-0000-0000-0000-000000000001');
  exception when others then v_err := sqlerrm; end;
  if v_err is null or v_err not like '%is more than the ₹5000 still owed%' then raise exception 'FAIL: overpayment accepted (%)', v_err; end if;
  raise notice 'PASS: cannot pay more than is owed';

  v_err := null;
  begin
    perform public.create_payment_run('[{"source":"vendor_bill","doc_id":"VB-PR-USD","amount":100}]'::jsonb, 'c1630000-0000-0000-0000-000000000001');
  exception when others then v_err := sqlerrm; end;
  if v_err is null or v_err not like 'VB-PR-USD is already paid or not found%' then raise exception 'FAIL: a USD bill went into a rupee run (%)', v_err; end if;
  raise notice 'PASS: foreign-currency bill stays out of a payment run';
end $$;

-- 3. Billing cannot approve; a manager cannot approve their own run; the owner can.
do $$
declare v_err text; v_run1 uuid := current_setting('pr.run1')::uuid; v_run2 uuid; v_st text;
begin
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000c');
  begin perform public.approve_payment_run(v_run1);
  exception when insufficient_privilege then v_err := sqlerrm; end;
  if v_err is null or v_err not like 'Only the owner or a manager can approve%' then raise exception 'FAIL: billing approved (%)', v_err; end if;
  raise notice 'PASS: billing cannot approve';

  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000b');
  v_run2 := public.create_payment_run('[{"source":"vendor_bill","doc_id":"VB-PR-2","amount":5000}]'::jsonb, 'c1630000-0000-0000-0000-000000000001');
  perform set_config('pr.run2', v_run2::text, true);
  v_err := null;
  begin perform public.approve_payment_run(v_run2);
  exception when insufficient_privilege then v_err := sqlerrm; end;
  if v_err is null or v_err not like 'A manager cannot approve a run they created%' then raise exception 'FAIL: manager approved own run (%)', v_err; end if;
  raise notice 'PASS: manager cannot approve own run';

  perform public.approve_payment_run(v_run1);   -- manager approves billing's run
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000a');
  perform public.approve_payment_run(v_run2);   -- owner approves manager's run
  select status into v_st from public.payment_runs where id = v_run2;
  if v_st <> 'approved' then raise exception 'FAIL: run2 is %', v_st; end if;
  raise notice 'PASS: manager approves another''s run, owner approves';
end $$;

-- 4. Mark paid: bills and expense settle, bank lines appear, a second mark is refused.
do $$
declare v_err text; v_run1 uuid := current_setting('pr.run1')::uuid; v_st text; v_paid int; v_e boolean; v_rec uuid; v_n int;
begin
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000c');
  perform public.mark_payment_run_paid(v_run1, current_date);
  select status, paid_amount into v_st, v_paid from public.vendor_bills where id = 'VB-PR-1';
  select paid, reconciled_txn_id into v_e, v_rec from public.expenses where id = 'EXP-PR-1';
  select count(*) into v_n from public.bank_transactions
   where tenant_id = 'b1630000-0000-0000-0000-000000000001' and reference = (select run_no from public.payment_runs where id = v_run1);
  if v_st <> 'paid' or v_paid <> 10000 or not v_e or v_rec is null or v_n <> 2 then
    raise exception 'FAIL: after paid — bill % %, expense % %, bank lines %', v_st, v_paid, v_e, v_rec, v_n;
  end if;
  raise notice 'PASS: run paid — bill paid, expense paid + reconciled, 2 bank lines';

  begin perform public.mark_payment_run_paid(v_run1, current_date);
  exception when others then v_err := sqlerrm; end;
  if v_err is null or v_err not like 'Only an approved run can be marked paid%' then raise exception 'FAIL: paid twice (%)', v_err; end if;
  raise notice 'PASS: a paid run cannot be paid again';
end $$;

-- 5. Paid by hand after approval → marking the run paid refuses, and changes nothing.
do $$
declare v_err text; v_run2 uuid := current_setting('pr.run2')::uuid; v_st text;
begin
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000a');
  perform public.pay_vendor_bill('VB-PR-2', 5000, current_date, 'c1630000-0000-0000-0000-000000000001', 'neft');
  begin perform public.mark_payment_run_paid(v_run2, current_date);
  exception when others then v_err := sqlerrm; end;
  if v_err is null or v_err not like '%was paid elsewhere after approval%' then raise exception 'FAIL: double payment went through (%)', v_err; end if;
  select status into v_st from public.payment_runs where id = v_run2;
  if v_st <> 'approved' then raise exception 'FAIL: run2 changed to % on a refused mark', v_st; end if;
  raise notice 'PASS: paid-elsewhere bill blocks the run';
  perform public.cancel_payment_run(v_run2);
  select status into v_st from public.payment_runs where id = v_run2;
  if v_st <> 'cancelled' then raise exception 'FAIL: cancel left %', v_st; end if;
  raise notice 'PASS: owner cancels an approved run';
end $$;

-- 6. Members cannot write the tables directly; another tenant sees nothing.
do $$
declare v_err text; v_n int;
begin
  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000a');
  select count(*) into v_n from public.payment_runs;
  if v_n <> 2 then raise exception 'FAIL: setup — owner sees % runs, expected 2', v_n; end if;
  begin
    update public.payment_runs set status = 'paid';
    get diagnostics v_n = row_count;
    if v_n > 0 then v_err := 'updated'; end if;
  exception when insufficient_privilege then v_err := null; v_n := -1; end;
  if v_err is not null then raise exception 'FAIL: a member updated payment_runs directly'; end if;
  if v_n <> -1 then raise exception 'FAIL: direct update was not refused by privilege (row_count %)', v_n; end if;
  raise notice 'PASS: no direct writes';

  perform pg_temp.act_as('a1630000-0000-0000-0000-00000000000e');
  select count(*) into v_n from public.payment_runs;
  if v_n <> 0 then raise exception 'FAIL: another tenant sees % runs', v_n; end if;
  raise notice 'PASS: another tenant sees no runs';
end $$;

reset role;
select 'PASS payment_runs' as result;
rollback;
