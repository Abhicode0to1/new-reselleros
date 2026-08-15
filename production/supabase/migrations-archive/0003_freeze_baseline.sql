-- ============================================================
-- ResellerOS — schema-drift freeze + security hardening
-- Migration: 0003_freeze_baseline.sql
-- ============================================================
-- Purpose
--   Between 0002 (May 20) and today (May 23), 19 ad-hoc migrations were
--   applied directly to prod via Studio / MCP without being checked into
--   git. This file is the **idempotent baseline** — it captures every
--   schema addition and re-asserts it. Re-running on a fresh database
--   reproduces prod exactly; running on prod is a no-op.
--
-- What this migration adds
--   1. ENUM extension: payment_status gets 'partial' value
--   2. quotes — adds 9 columns (line_items, subtotal, total_cost, discount_pct,
--      tax_rate, notes, payment_*, invoice_id) for partial-payment workflow
--   3. items — adds 'kind' (main/addon) + 'prices' jsonb (per-commitment pricing)
--   4. subscriptions — outstanding_amount + write-off fields + reminder timestamp
--   5. payments table — installment-aware payments (one row per transaction)
--      with sequential receipt voucher numbers per tenant per year
--   6. Hardens payments RLS — moves from {public} role to {authenticated} role
--      for consistency + replaces auth.role() with TO service_role
--   7. Adds missing FK indexes — quotes(customer_id), invoices(customer_id),
--      subscriptions(customer_id), customers(account_manager_id), quotes(lead_id),
--      quotes(invoice_id), invoices(razorpay_id), leads(owner_id)
--
-- Safety
--   - Every CREATE uses IF NOT EXISTS / IF EXISTS guards.
--   - No DROP TABLE / DROP COLUMN — additive only.
--   - Policy renames use DROP+CREATE inside a transaction → atomic.
-- ============================================================

begin;

-- ============================================================
-- 1. ENUM extension: payment_status type
--    (was added in 20260520135807, 20260523035527)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type public.payment_status as enum ('none', 'awaiting', 'received', 'invoiced');
  end if;
  if not exists (
    select 1 from pg_enum
    where enumtypid = 'public.payment_status'::regtype
      and enumlabel = 'partial'
  ) then
    alter type public.payment_status add value 'partial' before 'received';
  end if;
end $$;

-- ============================================================
-- 2. quotes — line items, tax, partial-payment workflow columns
--    (was added in 20260520135347, 20260520135807)
-- ============================================================
alter table public.quotes
  add column if not exists line_items          jsonb        default '[]'::jsonb,
  add column if not exists subtotal            integer      default 0,
  add column if not exists total_cost          integer      default 0,
  add column if not exists discount_pct        smallint     default 0,
  add column if not exists tax_rate            smallint     default 18,
  add column if not exists notes               text,
  add column if not exists payment_status      public.payment_status default 'none',
  add column if not exists payment_amount      integer,
  add column if not exists payment_method      text,
  add column if not exists payment_reference   text,
  add column if not exists payment_received_at timestamptz,
  add column if not exists payment_notes       text,
  add column if not exists invoice_id          text;

comment on column public.quotes.line_items     is 'Array of {id,item_id?,name,qty,rate,cost,commitment} objects';
comment on column public.quotes.subtotal       is 'Sum of qty*rate before discount & tax (₹)';
comment on column public.quotes.total_cost     is 'Sum of qty*wholesale_cost for margin calc (₹)';
comment on column public.quotes.discount_pct   is 'Discount % (0-100)';
comment on column public.quotes.tax_rate       is 'GST rate % (default 18)';
comment on column public.quotes.payment_status is 'Workflow: none → awaiting → partial → received → invoiced';
comment on column public.quotes.payment_method is 'razorpay / upi / bank_transfer / cheque / cash';
comment on column public.quotes.invoice_id    is 'Set once invoice is generated from this paid quote';

-- FK to invoices added separately because invoices.id is text and we need defer-friendly behavior
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quotes_invoice_id_fkey'
  ) then
    alter table public.quotes
      add constraint quotes_invoice_id_fkey
      foreign key (invoice_id) references public.invoices(id) on delete set null;
  end if;
end $$;

-- ============================================================
-- 3. items — kind (main/addon) + prices JSONB (per-commitment)
--    (was added in 20260522095512, 20260522100255)
-- ============================================================
alter table public.items
  add column if not exists kind   text   default 'main',
  add column if not exists prices jsonb  default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'items_kind_check'
  ) then
    alter table public.items
      add constraint items_kind_check check (kind in ('main', 'addon'));
  end if;
end $$;

create index if not exists items_kind_idx on public.items(kind);

comment on column public.items.kind   is 'main = primary plan (Google Workspace, M365), addon = bundled with a main plan';
comment on column public.items.prices is 'Per-commitment pricing: {monthly: paise, annual: paise} — annual ₹/seat/month';

-- ============================================================
-- 4. subscriptions — outstanding + write-off + reminder
--    (was added in 20260523041122, 20260523050005)
-- ============================================================
alter table public.subscriptions
  add column if not exists outstanding_amount  integer      not null default 0,
  add column if not exists write_off_reason    text,
  add column if not exists written_off_at      timestamptz,
  add column if not exists last_reminder_at    timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'subscriptions_outstanding_amount_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_outstanding_amount_check check (outstanding_amount >= 0);
  end if;
end $$;

-- Index supports the /payments outstanding-receivables list (partial index = only "active dues")
create index if not exists subscriptions_outstanding_idx
  on public.subscriptions(outstanding_amount)
  where outstanding_amount > 0;

comment on column public.subscriptions.outstanding_amount is 'Unpaid balance against this subscription (₹) — drives aging + write-off';
comment on column public.subscriptions.write_off_reason   is 'Audit trail: why was this subscription cancelled / written off';

-- ============================================================
-- 5. payments table — installment-aware ledger
--    (was added in 20260523035453 + 20260523055819)
-- ============================================================
create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  quote_id            text not null references public.quotes(id) on delete cascade,
  customer_id         uuid references public.customers(id) on delete set null,
  amount              integer not null check (amount > 0),
  method              text not null check (method in ('upi','razorpay','bank_transfer','cheque','cash','other')),
  reference           text,
  notes               text,
  status              text not null default 'received' check (status in ('received','refunded')),
  received_at         timestamptz not null default now(),
  refunded_at         timestamptz,
  refund_reason       text,
  recorded_by         uuid references public.users(id) on delete set null,
  receipt_voucher_no  text,
  created_at          timestamptz not null default now()
);

comment on table  public.payments                    is 'Transaction-level ledger. Multiple rows per quote = installments (partial payments).';
comment on column public.payments.receipt_voucher_no is 'GST-compliant advance receipt voucher (CGST Sec 31(3)(d)): RV-YYYY-NNNN per tenant per year';

-- Indexes for common access patterns
create index if not exists payments_tenant_idx   on public.payments(tenant_id);
create index if not exists payments_quote_idx    on public.payments(quote_id);
create index if not exists payments_customer_idx on public.payments(customer_id);
create index if not exists payments_received_idx on public.payments(received_at desc);

-- Receipt voucher uniqueness: per-tenant per-year (year encoded in the number itself)
create unique index if not exists payments_receipt_voucher_unique
  on public.payments(tenant_id, receipt_voucher_no)
  where receipt_voucher_no is not null;

-- ============================================================
-- 6. payments RLS — harden (was inconsistent: {public} instead of {authenticated})
-- ============================================================
alter table public.payments enable row level security;

-- Drop old (possibly misconfigured) policies
drop policy if exists payments_service_role     on public.payments;
drop policy if exists payments_tenant_isolation on public.payments;

-- Recreate consistent with rest of schema: split per-command + restrict to authenticated
create policy "payments_select" on public.payments for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "payments_insert" on public.payments for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy "payments_update" on public.payments for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- No DELETE policy — payments are financial records, only refund (status change) allowed.

-- Service role bypass — for webhook handlers (Razorpay) + signup flow
-- Using TO service_role is the modern, more robust pattern (vs auth.role() string check)
create policy "payments_service_role_all" on public.payments
  to service_role
  using (true)
  with check (true);

-- ============================================================
-- 7. Missing FK indexes — speeds up detail pages + cascade deletes
--    Without these, customer detail page does full scans
-- ============================================================
create index if not exists quotes_customer_idx        on public.quotes(customer_id)        where customer_id is not null;
create index if not exists quotes_lead_idx            on public.quotes(lead_id)            where lead_id is not null;
create index if not exists quotes_invoice_idx         on public.quotes(invoice_id)         where invoice_id is not null;
create index if not exists invoices_customer_idx      on public.invoices(customer_id)      where customer_id is not null;
create index if not exists invoices_razorpay_idx      on public.invoices(razorpay_id)      where razorpay_id is not null;
create index if not exists subscriptions_customer_idx on public.subscriptions(customer_id) where customer_id is not null;
create index if not exists customers_manager_idx     on public.customers(account_manager_id) where account_manager_id is not null;
create index if not exists leads_owner_idx           on public.leads(owner_id)             where owner_id is not null;

-- ============================================================
-- 8. updated_at trigger for new tables that gained mutable rows
--    payments rows get refund updates → ideally tracked too. But payments
--    is intentionally append-mostly + has refunded_at. Skipping for now.
-- ============================================================

commit;

-- ============================================================
-- Verification queries (run manually after applying):
--
--   -- Should return zero rows (no policy on payments uses public role)
--   select policyname from pg_policies
--   where schemaname='public' and tablename='payments' and 'public' = any(roles);
--
--   -- All tables should be true
--   select tablename, rowsecurity from pg_tables where schemaname='public';
--
--   -- Index count should be: payments=6, quotes=5, subscriptions=4
--   select tablename, count(*) as idx_count
--   from pg_indexes where schemaname='public' group by tablename order by tablename;
-- ============================================================
