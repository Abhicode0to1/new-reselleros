-- 0085: Employee loans / advances.
--
-- An employee borrows money from the company. Accounting-correct treatment:
-- this is NOT an expense — it's an ASSET (money the company is owed). Booking
-- it as an expense would understate both profit and assets.
--
-- Model (books-lite; mirrors petty cash / account transfers in 0083):
--   • Disburse  → money leaves a bank/cash account (a bank_transactions debit)
--                 and an employee_loans row is created for the principal.
--   • Repayment → cash/bank repayment is money arriving (a bank_transactions
--                 credit); a salary deduction moves NO cash (it's netted against
--                 payroll), so only the outstanding drops.
--   • Outstanding = principal − sum(repayments).  Loan auto-closes at zero.
--   • Balance Sheet picks up total outstanding as an asset (see balance-sheet.ts).
--
-- Both multi-row writes go through SECURITY DEFINER, tenant-scoped RPCs so a
-- mid-flight failure can never leave the loan and its cash leg out of sync
-- (CLAUDE.md §17b).

create table if not exists public.employee_loans (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  employee_name   text not null,
  principal       integer not null check (principal > 0),
  disbursed_on    date not null,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  notes           text,
  status          text not null default 'active' check (status in ('active', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.users(id) on delete set null
);

create table if not exists public.employee_loan_repayments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  loan_id         uuid not null references public.employee_loans(id) on delete cascade,
  amount          integer not null check (amount > 0),
  repaid_on       date not null,
  method          text not null check (method in ('cash', 'bank', 'salary_deduction')),
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists employee_loans_tenant_idx           on public.employee_loans(tenant_id, status);
create index if not exists employee_loan_repayments_loan_idx   on public.employee_loan_repayments(loan_id);

alter table public.employee_loans           enable row level security;
alter table public.employee_loan_repayments enable row level security;

drop policy if exists "tenant isolation read"   on public.employee_loans;
drop policy if exists "tenant isolation write"  on public.employee_loans;
drop policy if exists "tenant isolation update" on public.employee_loans;
drop policy if exists "tenant isolation delete" on public.employee_loans;
create policy "tenant isolation read"   on public.employee_loans for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.employee_loans for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.employee_loans for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.employee_loans for delete using  (tenant_id = public.current_tenant_id());

drop policy if exists "tenant isolation read"   on public.employee_loan_repayments;
drop policy if exists "tenant isolation write"  on public.employee_loan_repayments;
drop policy if exists "tenant isolation delete" on public.employee_loan_repayments;
create policy "tenant isolation read"   on public.employee_loan_repayments for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.employee_loan_repayments for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.employee_loan_repayments for delete using  (tenant_id = public.current_tenant_id());

-- ── Disburse: create the loan + move cash out (atomic) ──────────────────────
create or replace function public.disburse_employee_loan(
  p_employee_name   text,
  p_principal       integer,
  p_disbursed_on    date,
  p_bank_account_id uuid,
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
begin
  if p_principal is null or p_principal <= 0 then
    raise exception 'Loan amount must be positive';
  end if;
  if trim(coalesce(p_employee_name, '')) = '' then
    raise exception 'Employee name is required';
  end if;

  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, notes, created_by)
  values
    (v_tenant, trim(p_employee_name), p_principal, p_disbursed_on, p_bank_account_id,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_loan;

  -- Cash leaves the account (money out to the employee).
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_disbursed_on,
     'Loan to ' || trim(p_employee_name), p_principal, 0, 'manual', 'manual', 'manual');

  return v_loan;
end;
$$;

grant execute on function public.disburse_employee_loan(text, integer, date, uuid, text) to authenticated;

-- ── Repayment: record it + (for cash/bank) money in (atomic) ────────────────
create or replace function public.record_employee_loan_repayment(
  p_loan_id         uuid,
  p_amount          integer,
  p_repaid_on       date,
  p_method          text,
  p_bank_account_id uuid default null,
  p_notes           text default null
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
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Repayment amount must be positive';
  end if;
  if p_method not in ('cash', 'bank', 'salary_deduction') then
    raise exception 'Invalid repayment method';
  end if;

  select * into v_loan from public.employee_loans
    where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = p_loan_id;
  v_outstanding := v_loan.principal - v_paid;

  if p_amount > v_outstanding then
    raise exception 'Repayment (%) exceeds outstanding (%)', p_amount, v_outstanding;
  end if;

  -- Cash/bank repayment: money physically returns to an account — validate it.
  if p_method in ('cash', 'bank') then
    if p_bank_account_id is null then
      raise exception 'A receiving account is required for a % repayment', p_method;
    end if;
    perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
    if not found then raise exception 'Receiving account not found'; end if;
  end if;

  insert into public.employee_loan_repayments
    (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
  values
    (v_tenant, p_loan_id, p_amount, p_repaid_on, p_method,
     case when p_method = 'salary_deduction' then null else p_bank_account_id end,
     nullif(trim(coalesce(p_notes, '')), ''));

  -- Cash/bank repayment → money arrives back in the account.
  if p_method in ('cash', 'bank') then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_repaid_on,
       'Loan repayment — ' || v_loan.employee_name, 0, p_amount, 'manual', 'manual', 'manual');
  end if;

  -- Auto-close when fully repaid.
  update public.employee_loans
     set status     = case when v_outstanding - p_amount <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = p_loan_id;
end;
$$;

grant execute on function public.record_employee_loan_repayment(uuid, integer, date, text, uuid, text) to authenticated;
