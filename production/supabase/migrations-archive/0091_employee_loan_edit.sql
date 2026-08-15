-- 0091: Edit / delete an employee loan or advance (correct a mistake).
--
-- Both are money-touching: disbursing posted a bank_transactions debit, so a
-- correction must keep the bank balance right. Rules:
--   • Only allowed while the loan has NO repayments/settlements (once money has
--     moved again, the operator must reverse those first — we don't silently
--     unwind a partly-repaid loan).
--   • EDIT: if the amount or the source account changed, post a compensating
--     CREDIT for the old amount on the old account (reverses the original cash
--     out) and a fresh DEBIT for the new amount on the new account. The pair is
--     the honest audit trail of the correction.
--   • DELETE: post the compensating CREDIT (cash back) and remove the loan.
-- Atomic + tenant-scoped (SECURITY DEFINER).

create or replace function public.edit_employee_loan(
  p_loan_id         uuid,
  p_employee_name   text,
  p_principal       integer,
  p_disbursed_on    date,
  p_bank_account_id uuid,
  p_kind            text,
  p_notes           text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   public.employee_loans;
  v_paid   integer;
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'loan');
  v_name   text := trim(coalesce(p_employee_name, ''));
begin
  if p_principal is null or p_principal <= 0 then raise exception 'Amount must be positive'; end if;
  if v_name = '' then raise exception 'Employee name is required'; end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then raise exception 'Invalid kind'; end if;

  select * into v_loan from public.employee_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements — reverse those first before editing.';
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  -- Money changed? reverse the old cash out, post the new one.
  if p_principal <> v_loan.principal or p_bank_account_id is distinct from v_loan.bank_account_id then
    if v_loan.bank_account_id is not null then
      insert into public.bank_transactions
        (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
      values
        (v_tenant, v_loan.bank_account_id, (now() at time zone 'Asia/Kolkata')::date,
         'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
    end if;
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_disbursed_on,
       case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || v_name || ' (edited)',
       p_principal, 0, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set employee_name   = v_name,
         principal       = p_principal,
         disbursed_on    = p_disbursed_on,
         bank_account_id = p_bank_account_id,
         kind            = v_kind,
         notes           = nullif(trim(coalesce(p_notes, '')), ''),
         updated_at      = now()
   where id = p_loan_id;
end;
$$;

grant execute on function public.edit_employee_loan(uuid, text, integer, date, uuid, text, text) to authenticated;

create or replace function public.delete_employee_loan(
  p_loan_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   public.employee_loans;
  v_paid   integer;
begin
  select * into v_loan from public.employee_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements — reverse those first before deleting.';
  end if;

  -- Put the disbursed cash back.
  if v_loan.bank_account_id is not null then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, v_loan.bank_account_id, (now() at time zone 'Asia/Kolkata')::date,
       'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
  end if;

  delete from public.employee_loans where id = p_loan_id;
end;
$$;

grant execute on function public.delete_employee_loan(uuid) to authenticated;
