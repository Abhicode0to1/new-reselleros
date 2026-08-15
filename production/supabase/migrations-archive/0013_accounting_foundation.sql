-- ============================================================
-- ResellerOS — Accounting foundation (Phase 1)
-- Migration: 0013_accounting_foundation.sql
-- ============================================================
-- Adds two new tables to capture the money OUT side of the reseller's
-- business so we can produce P&L, GST reports, and aging without
-- re-keying into Tally/Zoho Books.
--
--   vendor_bills  — bills RECEIVED from suppliers (Google CSP, MS Partner,
--                   Zoho Partner). Source of COGS for P&L + input GST for
--                   GSTR-2A reconciliation.
--   expenses      — operating expenses (hosting, salaries, software,
--                   office, marketing). NOT COGS — separate line in P&L.
-- ============================================================

begin;

-- ── vendor_bills ────────────────────────────────────────────────────
create table public.vendor_bills (
  id                text         primary key,
  tenant_id         uuid         not null references public.tenants(id) on delete cascade,
  vendor_name       text         not null,
  vendor_gstin      text,
  bill_no           text,
  bill_date         date         not null,
  due_date          date,
  category          text         not null default 'COGS-Other',
  line_items        jsonb        not null default '[]'::jsonb,
  subtotal          integer      not null default 0,
  cgst              integer      not null default 0,
  sgst              integer      not null default 0,
  igst              integer      not null default 0,
  total             integer      not null,
  status            text         not null default 'unpaid',
  paid_amount       integer      not null default 0,
  notes             text,
  attachment_url    text,
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now()
);

create index idx_vendor_bills_tenant_date     on public.vendor_bills (tenant_id, bill_date desc);
create index idx_vendor_bills_tenant_status   on public.vendor_bills (tenant_id, status) where status <> 'paid';
create index idx_vendor_bills_tenant_category on public.vendor_bills (tenant_id, category);

alter table public.vendor_bills enable row level security;

create policy vendor_bills_select_own_tenant on public.vendor_bills for select
  using (tenant_id = public.current_tenant_id());
create policy vendor_bills_insert_own_tenant on public.vendor_bills for insert
  with check (tenant_id = public.current_tenant_id());
create policy vendor_bills_update_own_tenant on public.vendor_bills for update
  using (tenant_id = public.current_tenant_id());
create policy vendor_bills_delete_own_tenant on public.vendor_bills for delete
  using (tenant_id = public.current_tenant_id());

create trigger trg_vendor_bills_updated_at
  before update on public.vendor_bills
  for each row execute function public.handle_updated_at();

-- ── expenses ────────────────────────────────────────────────────────
create table public.expenses (
  id                text         primary key,
  tenant_id         uuid         not null references public.tenants(id) on delete cascade,
  category          text         not null,
  vendor_name       text,
  expense_date      date         not null,
  amount            integer      not null,
  gst_paid          integer      not null default 0,
  payment_method    text,
  description       text,
  attachment_url    text,
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now()
);

create index idx_expenses_tenant_date     on public.expenses (tenant_id, expense_date desc);
create index idx_expenses_tenant_category on public.expenses (tenant_id, category);

alter table public.expenses enable row level security;

create policy expenses_select_own_tenant on public.expenses for select
  using (tenant_id = public.current_tenant_id());
create policy expenses_insert_own_tenant on public.expenses for insert
  with check (tenant_id = public.current_tenant_id());
create policy expenses_update_own_tenant on public.expenses for update
  using (tenant_id = public.current_tenant_id());
create policy expenses_delete_own_tenant on public.expenses for delete
  using (tenant_id = public.current_tenant_id());

create trigger trg_expenses_updated_at
  before update on public.expenses
  for each row execute function public.handle_updated_at();

commit;
