-- 0144: PF (EPF) management in payroll — mirrors ESI (0140).
--   • employees.pf_applicable   — is this employee covered (has an EPFO account)
--   • salary_payments.pf_employer — employer's 12% share (employee 12% already in
--       the existing `pf` column, withheld from net)
--   • pay_salary gains p_pf_employer: stores it AND books the employer share as a
--       'statutory' expense (P&L-correct). It is NOT deducted from net pay and
--       does NOT leave the bank at salary time; it accrues to the statutory
--       payable and is cleared later by the PF (ECR) challan.
-- Rates/ceiling live in code: src/lib/payroll/pf.ts (12% / 12% / ₹15,000).

alter table public.employees
  add column if not exists pf_applicable boolean not null default false;

-- backfill: employees who already have an EPFO (PF) number are PF-applicable
update public.employees
   set pf_applicable = true
 where coalesce(trim(pf_no), '') <> '' and pf_applicable = false;

alter table public.salary_payments
  add column if not exists pf_employer integer not null default 0;

create or replace function public.pay_salary(
  p_employee_id uuid, p_period text, p_pay_date date, p_gross integer,
  p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer,
  p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer,
  p_other integer, p_bank_account_id uuid, p_notes text default null,
  p_incentive integer default 0, p_esi_employer integer default 0,
  p_pf_employer integer default 0
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
  v_pf_emp integer := greatest(coalesce(p_pf_employer,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_esi_exp_id text; v_pf_exp_id text; v_pay_id uuid;
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

  if v_esi_emp > 0 then
    v_esi_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'E';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_esi_exp_id, v_tenant, 'ESI — Employer', v_emp.name, p_pay_date, v_esi_emp, 0, 'statutory',
            'ESI employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  if v_pf_emp > 0 then
    v_pf_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'P';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_pf_exp_id, v_tenant, 'PF — Employer', v_emp.name, p_pay_date, v_pf_emp, 0, 'statutory',
            'PF employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered,
     tds, pf, esi, esi_employer, pf_employer, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv,
     v_tds, v_pf, v_esi, v_esi_emp, v_pf_emp, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid')
  returning id into v_pay_id;

  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $function$;

grant execute on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer) to authenticated;
