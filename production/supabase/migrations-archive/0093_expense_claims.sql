-- 0093: Employee self-service expense claims (against an expense advance).
--
-- An employee who was given an expense_advance (0086) can now log what they
-- spent it on THEMSELVES, from a shareable link + their attendance PIN — no
-- app login. Each submission is a PENDING claim; nothing touches the books
-- until the owner APPROVES it. On approval we run the exact settle-an-advance
-- money math (spent portion → a company expense, NO fresh cash leg — the cash
-- already left when the advance was disbursed) and reduce the advance.
--
-- Security:
--   • submit_expense_claim is SECURITY DEFINER and takes tenant_id explicitly
--     (the link is opened with no session) — it verifies the employee belongs
--     to that tenant + the bcrypt PIN before inserting. Claims land 'pending'.
--   • approve/reject are owner-only (current_tenant_id() from the session).
--   • Employee can only claim up to their advance's outstanding.

create table if not exists public.expense_claims (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  loan_id       uuid not null references public.employee_loans(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  amount        integer not null check (amount > 0),
  category      text not null,
  purpose       text,
  spent_on      date not null,
  receipt_path  text,                          -- storage path (expense-receipts bucket), optional
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  expense_id    text references public.expenses(id) on delete set null,  -- set on approval
  reject_reason text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists expense_claims_tenant_idx on public.expense_claims(tenant_id, status, created_at desc);
create index if not exists expense_claims_loan_idx   on public.expense_claims(loan_id);

alter table public.expense_claims enable row level security;

-- Owner (authenticated) reads/updates/deletes their tenant's claims. Inserts
-- happen through submit_expense_claim (SECURITY DEFINER) so no insert policy
-- for the anon/public path is needed.
drop policy if exists "tenant isolation read"   on public.expense_claims;
drop policy if exists "tenant isolation update" on public.expense_claims;
drop policy if exists "tenant isolation delete" on public.expense_claims;
create policy "tenant isolation read"   on public.expense_claims for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.expense_claims for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.expense_claims for delete using  (tenant_id = public.current_tenant_id());

-- Private bucket for receipt photos (owner views via signed URL, like selfies).
insert into storage.buckets (id, name, public)
values ('expense-receipts', 'expense-receipts', false)
on conflict (id) do nothing;

-- ── Employee submits a claim (public link + PIN, no session) ────────────────
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
  v_outstanding integer;
  v_claim      uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be more than zero';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;

  -- Verify the employee belongs to this tenant, is active, and the PIN matches.
  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if not v_emp.is_active then raise exception 'This employee is inactive'; end if;
  if v_emp.pin_hash is null then raise exception 'No PIN set for you — ask the office to set one'; end if;
  if p_pin is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  -- Find the employee's open expense advance (most recent active one).
  select * into v_loan from public.employee_loans
    where tenant_id = p_tenant_id and employee_name = v_emp.name
      and kind = 'expense_advance' and status = 'active'
    order by created_at desc limit 1;
  if not found then
    raise exception 'You have no open expense advance to claim against';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  v_outstanding := v_loan.principal - v_paid;
  if p_amount > v_outstanding then
    raise exception 'Amount (%) is more than your remaining advance (%)', p_amount, v_outstanding;
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

-- ── Owner approves a claim → books the expense + reduces the advance ─────────
create or replace function public.approve_expense_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_claim       public.expense_claims;
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
  v_exp_id      text;
begin
  select * into v_claim from public.expense_claims
    where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim is already %', v_claim.status; end if;

  select * into v_loan from public.employee_loans
    where id = v_claim.loan_id and tenant_id = v_tenant;
  if not found then raise exception 'The advance for this claim no longer exists'; end if;

  -- Re-check against the live outstanding (other claims may have been approved).
  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  v_outstanding := v_loan.principal - v_paid;
  if v_claim.amount > v_outstanding then
    raise exception 'Claim (%) now exceeds the remaining advance (%)', v_claim.amount, v_outstanding;
  end if;

  -- Spent portion → a company expense. NO bank leg (cash left at disburse).
  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, v_claim.category, v_loan.employee_name, v_claim.spent_on, v_claim.amount, 0, 'advance',
     coalesce(v_claim.purpose, 'Expense claim') || ' (claimed by ' || v_loan.employee_name || ')');

  insert into public.employee_loan_repayments
    (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes)
  values
    (v_tenant, v_loan.id, v_claim.amount, v_claim.spent_on, 'expense', null, v_exp_id, v_claim.purpose);

  update public.employee_loans
     set status     = case when (v_outstanding - v_claim.amount) <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = v_loan.id;

  update public.expense_claims
     set status = 'approved', expense_id = v_exp_id, reviewed_at = now()
   where id = p_claim_id;
end;
$$;

grant execute on function public.approve_expense_claim(uuid) to authenticated;

-- ── Owner rejects a claim (no money movement) ───────────────────────────────
create or replace function public.reject_expense_claim(p_claim_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  select status into v_status from public.expense_claims
    where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_status <> 'pending' then raise exception 'This claim is already %', v_status; end if;

  update public.expense_claims
     set status = 'rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''), reviewed_at = now()
   where id = p_claim_id and tenant_id = v_tenant;
end;
$$;

grant execute on function public.reject_expense_claim(uuid, text) to authenticated;
