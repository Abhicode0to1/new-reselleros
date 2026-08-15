-- 0094: Smoother expense-claim flow — verify PIN once, log many.
--
-- Two changes:
--   1. verify_claim_access() — checks the employee + PIN once and returns how
--      much of their advance is still claimable, so the public form can greet
--      them and then let them log several expenses in a row (PIN entered once).
--   2. submit_expense_claim() now subtracts already-PENDING claims from the
--      available amount (not just approved settlements), so an employee can't
--      queue up claims that together exceed their advance.
--
-- "Available to claim" = principal − approved repayments − pending claims.

create or replace function public.verify_claim_access(
  p_tenant_id   uuid,
  p_employee_id uuid,
  p_pin         text
) returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_emp         public.employees;
  v_loan        public.employee_loans;
  v_paid        integer;
  v_pending     integer;
begin
  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if not v_emp.is_active then raise exception 'This employee is inactive'; end if;
  if v_emp.pin_hash is null then raise exception 'No PIN set for you — ask the office to set one'; end if;
  if p_pin is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_loan from public.employee_loans
    where tenant_id = p_tenant_id and employee_name = v_emp.name
      and kind = 'expense_advance' and status = 'active'
    order by created_at desc limit 1;
  if not found then
    raise exception 'You have no open expense advance to claim against';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending';

  return (v_loan.principal - v_paid - v_pending);
end;
$$;

grant execute on function public.verify_claim_access(uuid, uuid, text) to anon, authenticated;

-- Update submit to also net off pending claims from the available amount.
create or replace function public.submit_expense_claim(
  p_tenant_id    uuid,
  p_employee_id  uuid,
  p_pin          text,
  p_amount       integer,
  p_category     text,
  p_purpose      text,
  p_spent_on     date,
  p_receipt_path text default null
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_emp        public.employees;
  v_loan       public.employee_loans;
  v_paid       integer;
  v_pending    integer;
  v_available  integer;
  v_claim      uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be more than zero';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;

  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if not v_emp.is_active then raise exception 'This employee is inactive'; end if;
  if v_emp.pin_hash is null then raise exception 'No PIN set for you — ask the office to set one'; end if;
  if p_pin is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_loan from public.employee_loans
    where tenant_id = p_tenant_id and employee_name = v_emp.name
      and kind = 'expense_advance' and status = 'active'
    order by created_at desc limit 1;
  if not found then
    raise exception 'You have no open expense advance to claim against';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending';
  v_available := v_loan.principal - v_paid - v_pending;

  if p_amount > v_available then
    raise exception 'Amount (%) is more than your remaining advance (%)', p_amount, v_available;
  end if;

  insert into public.expense_claims
    (tenant_id, loan_id, employee_id, amount, category, purpose, spent_on, receipt_path, status)
  values
    (p_tenant_id, v_loan.id, p_employee_id, p_amount, trim(p_category),
     nullif(trim(coalesce(p_purpose, '')), ''), coalesce(p_spent_on, current_date), p_receipt_path, 'pending')
  returning id into v_claim;

  return v_claim;
end;
$$;

grant execute on function public.submit_expense_claim(uuid, uuid, text, integer, text, text, date, text) to anon, authenticated;
