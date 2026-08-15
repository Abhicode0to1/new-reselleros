-- 0124 — a salary should be undo-able unless it's actually BANK-RECONCILED.
--
-- 0120 blocked undo/expense-delete whenever paid_status <> 'unpaid'. But a
-- salary can be 'paid' with NO bank link (legacy rows were migrated to 'paid';
-- a run can be marked paid without reconciling). Those got stuck: no Undo on
-- the payroll row (only unpaid showed it) AND the expense refused to delete.
--
-- Correct rule: block only when a real bank transaction is tied to it
-- (reconciled_txn_id is not null) — then you un-reconcile the bank line first.
-- Otherwise undo freely (reverses advance recovery + deletes the expense).

create or replace function public.delete_salary_payment(p_salary_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sp     public.salary_payments;
begin
  select * into v_sp from public.salary_payments where id = p_salary_id;
  if not found then raise exception 'Salary payment not found'; end if;
  if v_tenant is not null and v_sp.tenant_id is distinct from v_tenant then
    raise exception 'Salary payment not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sp.reconciled_txn_id is not null then
    raise exception 'This salary is reconciled to a bank transaction — un-reconcile that bank line first, then undo.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
    delete from public.employee_loan_repayments
     where tenant_id = v_sp.tenant_id and loan_id = v_sp.advance_loan_id
       and method = 'salary_deduction' and amount = v_sp.advance_recovered
       and repaid_on = v_sp.pay_date and notes = 'Recovered from salary ' || v_sp.period;
    update public.employee_loans set status = 'active', updated_at = now()
     where id = v_sp.advance_loan_id;
  end if;

  delete from public.salary_payments where id = p_salary_id;

  if v_sp.expense_id is not null then
    delete from public.expenses where id = v_sp.expense_id and tenant_id = v_sp.tenant_id;
  end if;
end;
$function$;

create or replace function public.tg_expense_delete_guards_salary()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_sp public.salary_payments;
begin
  select * into v_sp from public.salary_payments where expense_id = OLD.id;
  if found then
    if v_sp.reconciled_txn_id is not null then
      raise exception 'This salary is reconciled to a bank transaction — un-reconcile that bank line first (or undo from Payroll).'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
      delete from public.employee_loan_repayments
       where tenant_id = v_sp.tenant_id and loan_id = v_sp.advance_loan_id
         and method = 'salary_deduction' and amount = v_sp.advance_recovered
         and repaid_on = v_sp.pay_date and notes = 'Recovered from salary ' || v_sp.period;
      update public.employee_loans set status = 'active', updated_at = now()
       where id = v_sp.advance_loan_id;
    end if;
    delete from public.salary_payments where id = v_sp.id;
  end if;
  return OLD;
end;
$function$;
