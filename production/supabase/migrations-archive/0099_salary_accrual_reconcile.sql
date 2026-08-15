-- 0099: Salary accrual — "unpaid" until the bank statement confirms it.
--
-- Before: pay_salary booked the Salaries expense AND immediately posted the
-- net-pay as a bank debit → the salary showed "paid" the moment payroll ran,
-- and importing the real bank statement created a SECOND debit (double count).
--
-- After (accrual): running payroll books the expense (P&L) and records the
-- salary as UNPAID — no cash leg. The unpaid net shows as a "Salary payable"
-- liability on the Balance Sheet. When the real bank debit is imported and
-- reconciled to that salary, it flips to PAID and the imported line is the one
-- and only cash-out. No double counting.

-- 1) status columns. Everything already on the books moved cash → mark paid.
alter table public.salary_payments
  add column if not exists paid_status text not null default 'unpaid'
    check (paid_status in ('unpaid', 'paid'));
alter table public.salary_payments
  add column if not exists reconciled_txn_id uuid;
update public.salary_payments set paid_status = 'paid' where paid_status = 'unpaid';

-- allow reconciling a bank line to a salary (new match type)
alter table public.bank_transactions drop constraint if exists bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array['payment'::text,'expense'::text,'vendor_bill'::text,'transfer'::text,'salary'::text,'manual'::text]));

-- 2) pay_salary: accrue only (no net-pay bank leg). Salary lands 'unpaid'.
create or replace function public.pay_salary(
  p_employee_id       uuid,
  p_period            text,
  p_pay_date          date,
  p_gross             integer,
  p_lop_days          numeric,
  p_lop_amount        integer,
  p_advance_recovered integer,
  p_advance_loan_id   uuid,
  p_tds               integer,
  p_pf                integer,
  p_esi               integer,
  p_other             integer,
  p_bank_account_id   uuid,
  p_notes             text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_emp      public.employees;
  v_gross    integer := greatest(coalesce(p_gross, 0), 0);
  v_lop_amt  integer := greatest(coalesce(p_lop_amount, 0), 0);
  v_adv      integer := greatest(coalesce(p_advance_recovered, 0), 0);
  v_tds      integer := greatest(coalesce(p_tds, 0), 0);
  v_pf       integer := greatest(coalesce(p_pf, 0), 0);
  v_esi      integer := greatest(coalesce(p_esi, 0), 0);
  v_other    integer := greatest(coalesce(p_other, 0), 0);
  v_earned   integer;
  v_net      integer;
  v_exp_id   text;
  v_pay_id   uuid;
  v_loan     public.employee_loans;
  v_paid     integer;
  v_outstd   integer;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;

  v_earned := greatest(v_gross - v_lop_amt, 0);
  v_net    := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then
    raise exception 'Deductions (%) exceed earned salary (%)', v_adv + v_tds + v_pf + v_esi + v_other, v_earned;
  end if;

  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;

  -- Salaries EXPENSE = earned salary (gross − LOP). Accrual — no cash yet.
  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, 'Salaries', v_emp.name, p_pay_date, v_earned, 0, 'payroll',
     'Salary ' || p_period || ' — ' || v_emp.name);

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount,
     advance_recovered, tds, pf, esi, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days, 0), v_lop_amt,
     v_adv, v_tds, v_pf, v_esi, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end,
     nullif(trim(coalesce(p_notes, '')), ''), 'unpaid')
  returning id into v_pay_id;

  -- NOTE: no bank leg here anymore. The salary is 'unpaid' until the real
  -- bank debit is imported + reconciled to it (see the trigger below).

  -- Advance recovery → salary-deduction repayment (reduces the loan, no cash).
  if v_adv > 0 then
    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values
      (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans
       set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now()
     where id = p_advance_loan_id;
  end if;

  return v_pay_id;
end;
$$;
grant execute on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text) to authenticated;

-- 3) Flip a salary paid/unpaid when its bank line is reconciled / un-reconciled.
create or replace function public.sync_salary_paid_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.matched_to_type = 'salary' and new.matched_to_id is not null then
    update public.salary_payments
       set paid_status = 'paid', reconciled_txn_id = new.id
     where id = new.matched_to_id::uuid and tenant_id = new.tenant_id;
  elsif (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.matched_to_type = 'expense' and new.matched_to_id is not null then
    -- also covers matching directly to the Salaries expense (net = earned case)
    update public.salary_payments
       set paid_status = 'paid', reconciled_txn_id = new.id
     where expense_id = new.matched_to_id and tenant_id = new.tenant_id;
  end if;

  if tg_op = 'UPDATE' and old.matched_to_type is not null and new.matched_to_type is null then
    update public.salary_payments
       set paid_status = 'unpaid', reconciled_txn_id = null
     where reconciled_txn_id = old.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_salary_paid on public.bank_transactions;
create trigger trg_sync_salary_paid
  after insert or update on public.bank_transactions
  for each row execute function public.sync_salary_paid_status();

-- 4) Suggest matches: for a money-out line, also offer UNPAID salaries (net).
create or replace function public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
returns table (
  match_type      text,
  match_id        text,
  match_label     text,
  match_amount    integer,
  match_date      date,
  match_confidence text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txn record;
  v_tenant uuid;
  v_search_amount integer;
  v_is_credit boolean;
begin
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  v_tenant := v_txn.tenant_id;
  v_search_amount := greatest(v_txn.debit, v_txn.credit);
  v_is_credit := v_txn.credit > 0;

  if v_is_credit then
    return query
    select 'payment'::text, p.id::text,
           coalesce(c.name, p.receipt_voucher_no, 'Payment')
             || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end,
           p.amount, p.received_at::date,
           case when p.amount = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
                when p.amount = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high'
                else 'low' end::text
    from public.payments p
    left join public.customers c on c.id = p.customer_id
    where p.tenant_id = v_tenant and p.status = 'received'
      and abs(p.amount - v_search_amount) <= 100 and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs(p.amount - v_search_amount), abs(p.received_at::date - v_txn.txn_date)
    limit 5;
  end if;

  if not v_is_credit then
    -- Unpaid salaries (match by NET — the actual cash paid out)
    return query
    select 'salary'::text, sp.id::text,
           e.name || ' · salary ' || sp.period,
           sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high'
                else 'low' end::text
    from public.salary_payments sp
    join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid'
      and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date)
    limit 5;

    -- Vendor / other expenses
    return query
    select 'expense'::text, e.id::text,
           coalesce(e.vendor_name, e.category, 'Expense'),
           e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high'
                else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries'
      and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date)
    limit 5;
  end if;
end;
$$;
grant execute on function public.suggest_bank_transaction_matches(uuid) to authenticated;
