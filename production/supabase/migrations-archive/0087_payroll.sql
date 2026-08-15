-- 0087: Payroll + leave (simple, money-correct).
--
-- Employees get a monthly salary. Leave that is UNPAID becomes Loss of Pay
-- (LOP) and cuts that month's salary. A monthly salary payment computes:
--   net = gross − LOP − advance recovery − TDS − PF − ESI − other
-- and posts, atomically:
--   • a Salaries EXPENSE = earned salary (gross − LOP)   [P&L]
--   • a bank cash-out = net pay only                     [deductions aren't cash]
--   • an advance-recovery repayment on the employee's loan (salary deduction,
--     no cash leg — it just reduces the loan asset)
--   • withheld TDS/PF/ESI stay as a liability (paid to govt later via
--     pay_statutory_dues) — surfaced on the Balance Sheet.
--
-- TDS/PF/ESI are entered as amounts (no statutory auto-calc — that's the
-- "full statutory" scope, deliberately out of Phase 1).

create table if not exists public.employees (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  monthly_gross   integer not null default 0 check (monthly_gross >= 0),
  joining_date    date,
  leave_allowance integer not null default 18 check (leave_allowance >= 0),  -- paid leaves / year
  pan             text,
  pf_no           text,
  esi_no          text,
  is_active       boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.leave_entries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  from_date   date not null,
  to_date     date not null,
  days        numeric(5,1) not null check (days > 0),
  type        text not null check (type in ('casual', 'sick', 'earned', 'unpaid')),
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.salary_payments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  employee_id       uuid not null references public.employees(id) on delete cascade,
  period            text not null,                 -- 'YYYY-MM'
  pay_date          date not null,
  gross             integer not null check (gross >= 0),
  lop_days          numeric(5,1) not null default 0,
  lop_amount        integer not null default 0 check (lop_amount >= 0),
  advance_recovered integer not null default 0 check (advance_recovered >= 0),
  tds               integer not null default 0 check (tds >= 0),
  pf                integer not null default 0 check (pf >= 0),
  esi               integer not null default 0 check (esi >= 0),
  other_deduction   integer not null default 0 check (other_deduction >= 0),
  net               integer not null,
  bank_account_id   uuid references public.bank_accounts(id) on delete set null,
  expense_id        text references public.expenses(id) on delete set null,
  advance_loan_id   uuid references public.employee_loans(id) on delete set null,
  notes             text,
  created_at        timestamptz not null default now(),
  unique (tenant_id, employee_id, period)          -- one salary per employee per month
);

create table if not exists public.statutory_dues_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  kind            text not null default 'mixed' check (kind in ('tds', 'pf', 'esi', 'mixed')),
  amount          integer not null check (amount > 0),
  paid_on         date not null,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists employees_tenant_idx        on public.employees(tenant_id, is_active);
create index if not exists leave_entries_emp_idx        on public.leave_entries(employee_id, from_date);
create index if not exists salary_payments_tenant_idx   on public.salary_payments(tenant_id, period);
create index if not exists statutory_dues_tenant_idx    on public.statutory_dues_payments(tenant_id, paid_on);

alter table public.employees              enable row level security;
alter table public.leave_entries          enable row level security;
alter table public.salary_payments        enable row level security;
alter table public.statutory_dues_payments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['employees', 'leave_entries', 'salary_payments', 'statutory_dues_payments'] loop
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

-- ── Pay salary for one employee for a period (atomic) ───────────────────────
create or replace function public.pay_salary(
  p_employee_id       uuid,
  p_period            text,
  p_pay_date          date,
  p_gross             integer,
  p_lop_days          numeric,
  p_lop_amount        integer,
  p_advance_recovered integer,
  p_advance_loan_id   uuid,
  p_tds               integer,
  p_pf                integer,
  p_esi               integer,
  p_other             integer,
  p_bank_account_id   uuid,
  p_notes             text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_emp      public.employees;
  v_gross    integer := greatest(coalesce(p_gross, 0), 0);
  v_lop_amt  integer := greatest(coalesce(p_lop_amount, 0), 0);
  v_adv      integer := greatest(coalesce(p_advance_recovered, 0), 0);
  v_tds      integer := greatest(coalesce(p_tds, 0), 0);
  v_pf       integer := greatest(coalesce(p_pf, 0), 0);
  v_esi      integer := greatest(coalesce(p_esi, 0), 0);
  v_other    integer := greatest(coalesce(p_other, 0), 0);
  v_earned   integer;
  v_net      integer;
  v_exp_id   text;
  v_pay_id   uuid;
  v_loan     public.employee_loans;
  v_paid     integer;
  v_outstd   integer;
begin
  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;

  v_earned := greatest(v_gross - v_lop_amt, 0);          -- salary actually earned (expense)
  v_net    := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;   -- cash paid out
  if v_net < 0 then
    raise exception 'Deductions (%) exceed earned salary (%)', v_adv + v_tds + v_pf + v_esi + v_other, v_earned;
  end if;

  -- Advance recovery must fit the chosen loan's outstanding.
  if v_adv > 0 then
    if p_advance_loan_id is null then
      raise exception 'Pick which advance/loan the recovery reduces';
    end if;
    select * into v_loan from public.employee_loans
      where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount), 0) into v_paid
      from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then
      raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd;
    end if;
  end if;

  -- Salaries EXPENSE = earned salary (gross − LOP). No bank leg here; the cash
  -- movement is the net-pay debit below.
  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, 'Salaries', v_emp.name, p_pay_date, v_earned, 0, 'payroll',
     'Salary ' || p_period || ' — ' || v_emp.name);

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount,
     advance_recovered, tds, pf, esi, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days, 0), v_lop_amt,
     v_adv, v_tds, v_pf, v_esi, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end,
     nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_pay_id;

  -- Net pay leaves the bank/cash account.
  if v_net > 0 then
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence)
    values
      (v_tenant, p_bank_account_id, p_pay_date,
       'Salary ' || p_period || ' — ' || v_emp.name, v_net, 0, 'manual', 'expense', v_exp_id, 'manual');
  end if;

  -- Advance recovery → salary-deduction repayment (reduces the loan asset, no cash).
  if v_adv > 0 then
    insert into public.employee_loan_repayments
      (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values
      (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null,
       'Recovered from salary ' || p_period);
    update public.employee_loans
       set status     = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end,
           updated_at = now()
     where id = p_advance_loan_id;
  end if;

  return v_pay_id;
end;
$$;

grant execute on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text) to authenticated;

-- ── Record a statutory dues payment to govt (settles the withheld liability) ─
create or replace function public.pay_statutory_dues(
  p_amount          integer,
  p_kind            text,
  p_paid_on         date,
  p_bank_account_id uuid,
  p_notes           text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_acct   text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be positive';
  end if;
  select name into v_acct from public.bank_accounts
    where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Account not found'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes)
  values (v_tenant, coalesce(nullif(p_kind, ''), 'mixed'), p_amount, p_paid_on, p_bank_account_id,
          nullif(trim(coalesce(p_notes, '')), ''));

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_paid_on,
     'Statutory dues paid (' || coalesce(nullif(p_kind, ''), 'mixed') || ')', p_amount, 0, 'manual', 'manual', 'manual');
end;
$$;

grant execute on function public.pay_statutory_dues(integer, text, date, uuid, text) to authenticated;
