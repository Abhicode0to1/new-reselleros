-- 0086: Employee ADVANCES on top of the loans tracker (0085).
--
-- Two kinds of advance an SME gives staff:
--   • salary_advance — advance pay, recovered later (identical mechanics to a
--     loan: repaid via cash / bank / salary deduction). Just a labelled loan.
--   • expense_advance — money to SPEND on company work (travel, purchases).
--     This does NOT come back as cash; it SETTLES against real expense bills,
--     and only the unspent balance is returned. Crucially the cash already left
--     the account when the advance was disbursed (0085), so booking the expense
--     at settlement must NOT move cash again — otherwise it double-counts.
--
-- So we add:
--   • employee_loans.kind — 'loan' | 'salary_advance' | 'expense_advance'.
--   • a new repayment method 'expense' (a non-cash reduction that spawns an
--     expenses row) + an expense_id link.
--   • settle_expense_advance() — atomic: book the spent portion as an expense
--     (no cash leg) AND return the unspent balance to an account (a cash leg).

alter table public.employee_loans
  add column if not exists kind text not null default 'loan'
  check (kind in ('loan', 'salary_advance', 'expense_advance'));

alter table public.employee_loan_repayments
  drop constraint if exists employee_loan_repayments_method_check;
alter table public.employee_loan_repayments
  add constraint employee_loan_repayments_method_check
  check (method in ('cash', 'bank', 'salary_deduction', 'expense'));

alter table public.employee_loan_repayments
  add column if not exists expense_id text references public.expenses(id) on delete set null;

-- ── Settle an expense advance: expense portion (no cash) + returned cash ─────
create or replace function public.settle_expense_advance(
  p_loan_id        uuid,
  p_spent_amount   integer,      -- becomes a company expense (no fresh cash out)
  p_category       text,         -- expense category for the spent portion
  p_return_amount  integer,      -- unspent cash handed back (0 if none)
  p_return_account uuid,         -- account the unspent cash goes back into
  p_date           date,
  p_notes          text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
  v_exp_id      text;
  v_ret_method  text;
begin
  p_spent_amount  := coalesce(p_spent_amount, 0);
  p_return_amount := coalesce(p_return_amount, 0);

  if p_spent_amount < 0 or p_return_amount < 0 then
    raise exception 'Amounts cannot be negative';
  end if;
  if p_spent_amount + p_return_amount <= 0 then
    raise exception 'Nothing to settle';
  end if;

  select * into v_loan from public.employee_loans
    where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Advance not found'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = p_loan_id;
  v_outstanding := v_loan.principal - v_paid;

  if p_spent_amount + p_return_amount > v_outstanding then
    raise exception 'Settlement (%) exceeds outstanding (%)', p_spent_amount + p_return_amount, v_outstanding;
  end if;

  -- Spent portion → a company expense. NO bank leg: the cash left at disburse.
  if p_spent_amount > 0 then
    if trim(coalesce(p_category, '')) = '' then
      raise exception 'An expense category is required for the spent amount';
    end if;
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                       || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values
      (v_exp_id, v_tenant, trim(p_category), v_loan.employee_name, p_date, p_spent_amount, 0, 'advance',
       'Settled from expense advance to ' || v_loan.employee_name);

    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes)
    values
      (v_tenant, p_loan_id, p_spent_amount, p_date, 'expense', null, v_exp_id,
       nullif(trim(coalesce(p_notes, '')), ''));
  end if;

  -- Returned unspent cash → money arrives back in an account.
  if p_return_amount > 0 then
    if p_return_account is null then
      raise exception 'A receiving account is required for the returned cash';
    end if;
    select case when account_type = 'cash' then 'cash' else 'bank' end
      into v_ret_method
      from public.bank_accounts where id = p_return_account and tenant_id = v_tenant;
    if not found then raise exception 'Receiving account not found'; end if;

    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values
      (v_tenant, p_loan_id, p_return_amount, p_date, v_ret_method, p_return_account,
       nullif(trim(coalesce(p_notes, '')), ''));

    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_return_account, p_date,
       'Advance returned — ' || v_loan.employee_name, 0, p_return_amount, 'manual', 'manual', 'manual');
  end if;

  update public.employee_loans
     set status     = case when v_outstanding - (p_spent_amount + p_return_amount) <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$$;

grant execute on function public.settle_expense_advance(uuid, integer, text, integer, uuid, date, text) to authenticated;

-- ── Recreate disburse with a `kind` so the type is captured at creation ──────
drop function if exists public.disburse_employee_loan(text, integer, date, uuid, text);
create or replace function public.disburse_employee_loan(
  p_employee_name   text,
  p_principal       integer,
  p_disbursed_on    date,
  p_bank_account_id uuid,
  p_kind            text default 'loan',
  p_notes           text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_loan   uuid;
  v_acct   text;
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'loan');
begin
  if p_principal is null or p_principal <= 0 then
    raise exception 'Amount must be positive';
  end if;
  if trim(coalesce(p_employee_name, '')) = '' then
    raise exception 'Employee name is required';
  end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then
    raise exception 'Invalid kind';
  end if;

  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by)
  values
    (v_tenant, trim(p_employee_name), p_principal, p_disbursed_on, p_bank_account_id, v_kind,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_loan;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_disbursed_on,
     case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || trim(p_employee_name),
     p_principal, 0, 'manual', 'manual', 'manual');

  return v_loan;
end;
$$;

grant execute on function public.disburse_employee_loan(text, integer, date, uuid, text, text) to authenticated;
