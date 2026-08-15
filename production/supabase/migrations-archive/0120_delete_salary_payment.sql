-- 0120 — atomic UNDO for a salary payment (payroll reversal).
--
-- pay_salary() books three things: a 'Salaries' expense, a salary_payment
-- (unpaid), and (if an advance was recovered) a loan repayment + loan status.
-- Deleting just the expense left the salary_payment orphaned (expense_id nulled
-- via FK) so payroll still showed the employee as "unpaid" with no way to re-pay.
--
-- This RPC reverses the WHOLE thing in one transaction — but only while the
-- salary is still unpaid and not bank-reconciled. Once the real bank debit is
-- matched to it, un-reconcile that first.

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

  if v_sp.paid_status <> 'unpaid' or v_sp.reconciled_txn_id is not null then
    raise exception 'This salary is already paid / bank-reconciled — un-reconcile the bank line first, then undo.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Reverse an advance recovery: drop the salary-deduction repayment + reopen the loan.
  if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
    delete from public.employee_loan_repayments
     where tenant_id = v_sp.tenant_id
       and loan_id   = v_sp.advance_loan_id
       and method    = 'salary_deduction'
       and amount    = v_sp.advance_recovered
       and repaid_on = v_sp.pay_date
       and notes     = 'Recovered from salary ' || v_sp.period;
    update public.employee_loans set status = 'active', updated_at = now()
     where id = v_sp.advance_loan_id;
  end if;

  -- Delete the salary_payment FIRST so removing its expense doesn't re-trigger
  -- the guard below (no orphan, no recursion).
  delete from public.salary_payments where id = p_salary_id;

  -- Remove the P&L Salaries expense it booked.
  if v_sp.expense_id is not null then
    delete from public.expenses where id = v_sp.expense_id and tenant_id = v_sp.tenant_id;
  end if;
end;
$function$;

grant execute on function public.delete_salary_payment(uuid) to authenticated;

-- Guard: deleting the 'Salaries' expense a salary booked must not silently
-- orphan the payroll record. If it's still unpaid, reverse the salary too;
-- if it's already paid/reconciled, block (undo from Payroll instead).
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
    if v_sp.paid_status <> 'unpaid' or v_sp.reconciled_txn_id is not null then
      raise exception 'This is a paid salary''s expense — undo it from Payroll & Leave (un-reconcile the bank line first).'
        using errcode = 'invalid_parameter_value';
    end if;
    -- Unpaid: reverse the payroll record so nothing is orphaned. (Advance
    -- recovery reversal handled here too.)
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

drop trigger if exists trg_expense_delete_guards_salary on public.expenses;
create trigger trg_expense_delete_guards_salary
  before delete on public.expenses
  for each row execute function public.tg_expense_delete_guards_salary();
