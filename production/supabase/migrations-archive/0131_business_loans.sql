-- 0131: Business loans TAKEN by the company (e.g. a ₹10L HDFC term loan).
--
-- The mirror image of emi_purchases (0092): there the company BUYS an asset on
-- EMI; here the company BORROWS cash. No asset is created — the borrowed money
-- simply lands in a bank account.
--
-- Accounting (books-lite, money-correct):
--   • Disbursal: the principal comes INTO a chosen bank account (cash in). The
--     same amount is a LIABILITY (loan payable) until repaid. Net worth is
--     unchanged — you got cash but you owe it.
--   • EMI: the full instalment leaves the bank. Its PRINCIPAL part reduces the
--     loan liability; its INTEREST part is an expense (Interest). Identity:
--     cash_out = principal + interest, so the sheet always balances.
--     (Booking the whole EMI as an expense is the classic mistake — it
--      overstates expenses and hides the shrinking liability.)
--   • Balance Sheet auto-surfaces (principal − principal repaid) as a liability.
--     See balance-sheet.ts.
-- Both writes go through atomic, tenant-scoped SECURITY DEFINER RPCs.

create table if not exists public.business_loans (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  lender             text not null,                 -- e.g. "HDFC Bank"
  purpose            text,                           -- e.g. "Working capital"
  principal          integer not null check (principal > 0),
  interest_rate      numeric(6,2),                   -- annual %, optional (for reference)
  tenure_months      integer check (tenure_months is null or tenure_months > 0),
  emi_amount         integer check (emi_amount is null or emi_amount >= 0),
  disbursed_on       date not null,
  deposit_account_id uuid references public.bank_accounts(id) on delete set null,
  status             text not null default 'active' check (status in ('active','closed')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references public.users(id) on delete set null
);

create table if not exists public.business_loan_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  loan_id         uuid not null references public.business_loans(id) on delete cascade,
  amount          integer not null check (amount > 0),
  principal_part  integer not null check (principal_part >= 0),
  interest_part   integer not null default 0 check (interest_part >= 0),
  paid_on         date not null,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  expense_id      text references public.expenses(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists business_loans_tenant_idx on public.business_loans(tenant_id, status);
create index if not exists business_loan_payments_loan_idx on public.business_loan_payments(loan_id);

alter table public.business_loans         enable row level security;
alter table public.business_loan_payments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['business_loans','business_loan_payments'] loop
    execute format('drop policy if exists "tenant isolation read"   on public.%I', t);
    execute format('drop policy if exists "tenant isolation write"  on public.%I', t);
    execute format('drop policy if exists "tenant isolation update" on public.%I', t);
    execute format('drop policy if exists "tenant isolation delete" on public.%I', t);
    execute format('create policy "tenant isolation read"   on public.%I for select using  (tenant_id = public.current_tenant_id())', t);
    execute format('create policy "tenant isolation write"  on public.%I for insert with check (tenant_id = public.current_tenant_id())', t);
    execute format('create policy "tenant isolation update" on public.%I for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id())', t);
    execute format('create policy "tenant isolation delete" on public.%I for delete using  (tenant_id = public.current_tenant_id())', t);
  end loop;
end $$;

-- ── Record a loan: liability + principal cash IN (atomic) ────────────────────
create or replace function public.record_business_loan(
  p_lender         text,
  p_purpose        text,
  p_principal      integer,
  p_interest_rate  numeric,
  p_tenure_months  integer,
  p_emi_amount     integer,
  p_disbursed_on   date,
  p_deposit_account uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Loan amount must be positive'; end if;
  if trim(coalesce(p_lender, '')) = '' then raise exception 'Lender is required'; end if;
  if p_deposit_account is null then raise exception 'Pick the account the money was received into'; end if;
  perform 1 from public.bank_accounts where id = p_deposit_account and tenant_id = v_tenant;
  if not found then raise exception 'Deposit account not found'; end if;

  insert into public.business_loans
    (tenant_id, lender, purpose, principal, interest_rate, tenure_months, emi_amount, disbursed_on, deposit_account_id, status, created_by)
  values
    (v_tenant, trim(p_lender), nullif(trim(coalesce(p_purpose,'')),''), p_principal,
     p_interest_rate, nullif(greatest(coalesce(p_tenure_months,0),0),0), nullif(greatest(coalesce(p_emi_amount,0),0),0),
     p_disbursed_on, p_deposit_account, 'active', auth.uid())
  returning id into v_id;

  -- Principal lands in the bank (money in → credit).
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_deposit_account, p_disbursed_on, 'Loan received: ' || trim(p_lender), 0, p_principal, 'manual', 'manual', 'manual');

  return v_id;
end;
$$;

grant execute on function public.record_business_loan(text, text, integer, numeric, integer, integer, date, uuid) to authenticated;

-- ── Pay one EMI: cash out (full) + principal reduces loan, interest = expense ─
create or replace function public.record_loan_emi(
  p_loan_id         uuid,
  p_amount          integer,
  p_interest        integer,
  p_paid_on         date,
  p_bank_account_id uuid,
  p_notes           text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_l        public.business_loans;
  v_paidprin integer;
  v_outstd   integer;
  v_int      integer := greatest(coalesce(p_interest, 0), 0);
  v_prin     integer;
  v_exp_id   text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'EMI amount must be positive'; end if;
  v_prin := p_amount - v_int;
  if v_prin < 0 then raise exception 'Interest cannot exceed the EMI amount'; end if;

  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(principal_part), 0) into v_paidprin from public.business_loan_payments where loan_id = p_loan_id;
  v_outstd := v_l.principal - v_paidprin;
  if v_prin > v_outstd then raise exception 'Principal part (%) exceeds outstanding loan (%)', v_prin, v_outstd; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  -- Interest portion → an expense (no separate cash leg; the EMI debit below covers it).
  if v_int > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_exp_id, v_tenant, 'Interest', v_l.lender, p_paid_on, v_int, 0, 'emi', 'Loan interest — ' || v_l.lender);
  end if;

  insert into public.business_loan_payments
    (tenant_id, loan_id, amount, principal_part, interest_part, paid_on, bank_account_id, expense_id, notes)
  values
    (v_tenant, p_loan_id, p_amount, v_prin, v_int, p_paid_on, p_bank_account_id, v_exp_id, nullif(trim(coalesce(p_notes,'')),''));

  -- Full instalment leaves the bank.
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on, 'Loan EMI: ' || v_l.lender, p_amount, 0, 'manual', 'manual', 'manual');

  update public.business_loans
     set status = case when (v_outstd - v_prin) <= 0 then 'closed' else 'active' end, updated_at = now()
   where id = p_loan_id;
end;
$$;

grant execute on function public.record_loan_emi(uuid, integer, integer, date, uuid, text) to authenticated;

-- ── Delete a loan (only before any EMI is recorded): reverse the disbursal ────
create or replace function public.delete_business_loan(p_loan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_l      public.business_loans;
  v_pays   integer;
begin
  select * into v_l from public.business_loans where id = p_loan_id and tenant_id = v_tenant;
  if not found then raise exception 'Loan not found'; end if;

  select count(*) into v_pays from public.business_loan_payments where loan_id = p_loan_id;
  if v_pays > 0 then
    raise exception 'This loan has % EMI payment(s) recorded — delete those first', v_pays;
  end if;

  -- Reverse the disbursal bank credit (best-effort match on the same account/date/amount).
  if v_l.deposit_account_id is not null then
    delete from public.bank_transactions
     where tenant_id = v_tenant
       and bank_account_id = v_l.deposit_account_id
       and txn_date = v_l.disbursed_on
       and credit = v_l.principal
       and description = 'Loan received: ' || v_l.lender;
  end if;

  delete from public.business_loans where id = p_loan_id;
end;
$$;

grant execute on function public.delete_business_loan(uuid) to authenticated;
