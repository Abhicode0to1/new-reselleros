-- 0048: Banking module — bank accounts + transactions + reconciliation
--
-- Zoho Books-style banking. Operator adds their bank accounts (HDFC,
-- ICICI, SBI etc.), uploads statement CSVs, and reconciles incoming/
-- outgoing transactions against existing payments / expenses / vendor
-- bills already in ResellerOS.
--
-- Design choices:
-- • UUID primary keys (NOT per-tenant document numbers) — avoids the PK
--   collision bug we hit on quotes/POs where two tenants both generate
--   `Q-2026-27-0001` causing INSERT conflicts. Banking IDs are internal,
--   never shown to customers, so opaque UUIDs are fine.
-- • Last 4 digits only for account number — full number is sensitive and
--   not needed for matching. IFSC code IS stored (public knowledge).
-- • Single matched_to_type + matched_to_id columns instead of separate
--   matched_payment_id / matched_expense_id columns — keeps the schema
--   flat and the match logic generic across entity types.
-- • Money is stored as integer ₹ (paise conversion at integration boundary
--   later, not now).

-- ============================================================
-- bank_accounts
-- ============================================================
create table if not exists public.bank_accounts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  name                  text not null,            -- "HDFC Current Mumbai"
  bank_name             text not null,            -- "HDFC Bank"
  account_number_last4  text not null,            -- "1234" (last 4 only, security)
  ifsc                  text not null,            -- "HDFC0001234"
  account_type          text not null default 'current' check (account_type in ('current', 'savings', 'overdraft', 'fixed_deposit', 'other')),
  -- Opening balance (in ₹) recorded at account add time. New transactions
  -- adjust the computed current_balance below.
  opening_balance       integer not null default 0,
  opening_balance_date  date    not null default current_date,
  is_active             boolean not null default true,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists bank_accounts_tenant_idx on public.bank_accounts(tenant_id);

alter table public.bank_accounts enable row level security;

drop policy if exists "tenant isolation read"   on public.bank_accounts;
drop policy if exists "tenant isolation write"  on public.bank_accounts;
drop policy if exists "tenant isolation update" on public.bank_accounts;
drop policy if exists "tenant isolation delete" on public.bank_accounts;

create policy "tenant isolation read"   on public.bank_accounts for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.bank_accounts for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.bank_accounts for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.bank_accounts for delete using  (tenant_id = public.current_tenant_id());

-- ============================================================
-- bank_transactions
-- ============================================================
create table if not exists public.bank_transactions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  bank_account_id   uuid not null references public.bank_accounts(id) on delete cascade,

  txn_date          date    not null,
  description       text    not null,             -- bank's narration / particulars
  debit             integer not null default 0,  -- money going OUT (₹)
  credit            integer not null default 0,  -- money coming IN  (₹)
  balance_after     integer,                      -- per-row running balance from statement (optional)
  reference         text,                         -- UTR number, cheque #, NEFT ref, etc.

  -- Source of this row — manual entry, CSV upload, future API fetch
  source            text not null default 'manual' check (source in ('manual', 'csv_upload', 'api_fetch')),

  -- Reconciliation state. NULL = unmatched. When set, points to a row
  -- in one of: payments, expenses, vendor_bills, or another bank_txn
  -- (for inter-account transfers). matched_to_id is a text column so it
  -- can hold UUIDs (payments) OR text IDs (expenses).
  matched_to_type   text check (matched_to_type in ('payment', 'expense', 'vendor_bill', 'transfer', 'manual')),
  matched_to_id     text,
  matched_at        timestamptz,
  matched_by        uuid references auth.users(id),
  match_confidence  text check (match_confidence in ('exact', 'high', 'low', 'manual')),

  imported_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Defensive: exactly one of debit/credit must be > 0
  constraint debit_xor_credit check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  )
);

create index if not exists bank_txn_tenant_account_idx   on public.bank_transactions(tenant_id, bank_account_id);
create index if not exists bank_txn_unmatched_idx        on public.bank_transactions(tenant_id, matched_to_type) where matched_to_type is null;
create index if not exists bank_txn_date_idx             on public.bank_transactions(tenant_id, txn_date desc);

alter table public.bank_transactions enable row level security;

drop policy if exists "tenant isolation read"   on public.bank_transactions;
drop policy if exists "tenant isolation write"  on public.bank_transactions;
drop policy if exists "tenant isolation update" on public.bank_transactions;
drop policy if exists "tenant isolation delete" on public.bank_transactions;

create policy "tenant isolation read"   on public.bank_transactions for select using  (tenant_id = public.current_tenant_id());
create policy "tenant isolation write"  on public.bank_transactions for insert with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation update" on public.bank_transactions for update using  (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy "tenant isolation delete" on public.bank_transactions for delete using  (tenant_id = public.current_tenant_id());

-- ============================================================
-- Helper: compute current_balance for a bank_account
-- (Calculated on read since transactions can be added/edited.)
-- ============================================================
create or replace function public.bank_account_current_balance(p_account_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select opening_balance from public.bank_accounts where id = p_account_id),
    0
  ) + coalesce(
    (select sum(credit - debit)::int from public.bank_transactions where bank_account_id = p_account_id),
    0
  );
$$;

-- ============================================================
-- Helper: suggest reconciliation matches for a bank transaction
-- Returns nearest payments / expenses by amount + date proximity.
-- Used by Phase 2 (auto-match) but available for Phase 1 manual flow.
-- ============================================================
create or replace function public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
returns table (
  match_type      text,
  match_id        text,
  match_label     text,
  match_amount    integer,
  match_date      date,
  match_confidence text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txn record;
  v_tenant uuid;
  v_search_amount integer;
  v_is_credit boolean;
begin
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  v_tenant := v_txn.tenant_id;
  v_search_amount := greatest(v_txn.debit, v_txn.credit);
  v_is_credit := v_txn.credit > 0;

  -- Credits (money in) → match against payments table (customer paid us)
  if v_is_credit then
    return query
    select 'payment'::text as match_type,
           p.id::text      as match_id,
           coalesce(c.name, p.receipt_voucher_no, 'Payment')
             || case when p.reference is not null and p.reference <> ''
                     then ' · ' || p.reference else '' end as match_label,
           p.amount        as match_amount,
           p.received_at::date as match_date,
           case
             when p.amount = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
             when p.amount = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high'
             else 'low'
           end::text       as match_confidence
    from public.payments p
    left join public.customers c on c.id = p.customer_id
    where p.tenant_id = v_tenant
      and p.status = 'received'
      and abs(p.amount - v_search_amount) <= 100   -- within ₹100 (handles rounding)
      and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs(p.amount - v_search_amount), abs(p.received_at::date - v_txn.txn_date)
    limit 5;
  end if;

  -- Debits (money out) → match against expenses table (we paid someone)
  if not v_is_credit then
    return query
    select 'expense'::text as match_type,
           e.id::text      as match_id,
           coalesce(e.vendor_name, e.category, 'Expense') as match_label,
           e.amount        as match_amount,
           e.expense_date  as match_date,
           case
             when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
             when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high'
             else 'low'
           end::text       as match_confidence
    from public.expenses e
    where e.tenant_id = v_tenant
      and abs(e.amount - v_search_amount) <= 100
      and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date)
    limit 5;
  end if;
end;
$$;
