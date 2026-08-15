-- 0140: ESI (Employees' State Insurance) management in payroll.
--
-- Adds proper ESI handling to the money-spine:
--   • employees.esi_applicable  — is this employee covered (gross ≤ ₹21,000)
--   • salary_payments.esi_employer — the employer's 3.25% share (the employee's
--       0.75% already lives in the existing `esi` column, withheld from net)
--   • pay_salary gains p_esi_employer: stores it AND books the employer share as
--       a 'statutory' expense (P&L-correct) — it is NOT deducted from net pay and
--       does NOT leave the bank at salary time; it accrues to the statutory
--       payable and is cleared later by the ESIC challan.
--   • book_bank_txn_as_statutory — reconcile an *imported* ESIC/PF/TDS challan
--       bank line by recording a statutory_dues_payments row against it (settling
--       the payable) WITHOUT creating a duplicate/phantom bank line the way the
--       old pay_statutory_dues RPC does.
--
-- Rates/ceiling live in code: src/lib/payroll/esi.ts (0.75% / 3.25% / ₹21,000).

-- 1. schema ------------------------------------------------------------------
alter table public.employees
  add column if not exists esi_applicable boolean not null default false;

-- backfill: cover everyone at/under the wage ceiling (owner can override later)
update public.employees
   set esi_applicable = (monthly_gross is not null and monthly_gross > 0 and monthly_gross <= 21000)
 where esi_applicable is distinct from
       (monthly_gross is not null and monthly_gross > 0 and monthly_gross <= 21000);

alter table public.salary_payments
  add column if not exists esi_employer integer not null default 0;

alter table public.statutory_dues_payments
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null;

-- 2. allow 'statutory' as a bank-line match type -----------------------------
alter table public.bank_transactions drop constraint if exists bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array[
    'payment','expense','vendor_bill','transfer','salary','project','manual','split','statutory'
  ]));

-- 3. pay_salary — add employer-ESI (supersedes 0087 version) -----------------
create or replace function public.pay_salary(
  p_employee_id uuid, p_period text, p_pay_date date, p_gross integer,
  p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer,
  p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer,
  p_other integer, p_bank_account_id uuid, p_notes text default null,
  p_incentive integer default 0, p_esi_employer integer default 0
) returns uuid
  language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp public.employees;
  v_gross integer := greatest(coalesce(p_gross,0),0);
  v_lop_amt integer := greatest(coalesce(p_lop_amount,0),0);
  v_inc integer := greatest(coalesce(p_incentive,0),0);
  v_adv integer := greatest(coalesce(p_advance_recovered,0),0);
  v_tds integer := greatest(coalesce(p_tds,0),0);
  v_pf integer := greatest(coalesce(p_pf,0),0);
  v_esi integer := greatest(coalesce(p_esi,0),0);
  v_esi_emp integer := greatest(coalesce(p_esi_employer,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_esi_exp_id text; v_pay_id uuid;
  v_loan public.employee_loans; v_paid integer; v_outstd integer;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;
  v_earned := greatest(v_gross - v_lop_amt, 0) + v_inc;
  v_net := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then raise exception 'Deductions (%) exceed earned pay (%)', v_adv+v_tds+v_pf+v_esi+v_other, v_earned; end if;
  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount),0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, 'Salaries', v_emp.name, p_pay_date, v_earned, 0, 'payroll',
          'Salary ' || p_period || ' — ' || v_emp.name || case when v_inc > 0 then ' (incl. incentive)' else '' end);

  -- Employer ESI (3.25%) is an additional company cost, booked as a 'statutory'
  -- expense so the P&L is correct. It is settled via the statutory payable, not
  -- a per-line bank match, so it is kept out of the reconcile candidate list.
  if v_esi_emp > 0 then
    v_esi_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'E';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_esi_exp_id, v_tenant, 'ESI — Employer', v_emp.name, p_pay_date, v_esi_emp, 0, 'statutory',
            'ESI employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered,
     tds, pf, esi, esi_employer, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv,
     v_tds, v_pf, v_esi, v_esi_emp, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid')
  returning id into v_pay_id;

  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $function$;

grant execute on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer) to authenticated;

-- 4. reconcile an imported statutory challan line (no phantom line) -----------
create or replace function public.book_bank_txn_as_statutory(
  p_txn_id uuid, p_kind text, p_notes text default null
) returns void
  language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit,0) <= 0 then raise exception 'A statutory payment must be a money-out line'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes, bank_txn_id)
  values (v_tenant, coalesce(nullif(p_kind,''),'mixed'), v_txn.debit, v_txn.txn_date, v_txn.bank_account_id,
          nullif(trim(coalesce(p_notes,'')),''), p_txn_id);

  update public.bank_transactions
     set matched_to_type='statutory', matched_to_id=null, match_confidence='manual',
         matched_at=now(), matched_by=auth.uid(), updated_at=now()
   where id = p_txn_id;
end; $function$;

grant execute on function public.book_bank_txn_as_statutory(uuid, text, text) to authenticated;
