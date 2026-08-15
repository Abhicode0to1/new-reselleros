-- ============================================================
-- ResellerOS — TDS Receivable (Indian Income Tax Act §194)
-- Migration: 0014_tds_receivable.sql
-- ============================================================
-- Why
--   B2B customers deduct TDS (typically 10% u/s 194J for technical
--   services) before paying. ₹1,00,000 invoice + ₹18,000 GST = ₹1,18,000
--   billed, but customer pays only ₹1,08,000 (deducts ₹10,000 TDS on
--   pre-GST amount). They deposit ₹10,000 with govt against the reseller's
--   PAN. The reseller claims this in their ITR.
--
--   Without proper tracking:
--     1. Invoices stuck as "partial paid" forever (the TDS amount)
--     2. Form 16A certificates chase falls between cracks
--     3. Form 26AS mismatches (customer deducts but never deposits)
--        cause REAL money loss at ITR time.
--
-- What
--   New table tds_receivable: one row per TDS deduction event.
--   New columns on customers for customer-specific defaults (TAN, section, rate).
-- ============================================================

begin;

create table public.tds_receivable (
  id                      text         primary key,
  tenant_id               uuid         not null references public.tenants(id) on delete cascade,

  invoice_id              text         references public.invoices(id) on delete set null,
  payment_id              uuid         references public.payments(id) on delete set null,
  customer_id             uuid         references public.customers(id) on delete set null,
  customer_name           text         not null,
  customer_tan            text,

  section                 text         not null,
  rate_pct                numeric(5,2) not null,
  gross_amount            integer      not null,
  tds_amount              integer      not null,
  net_paid                integer      not null,

  fiscal_year             text         not null,
  payment_received_date   date         not null,

  status                  text         not null default 'pending_cert',

  form_16a_url            text,
  form_16a_received_date  date,
  appears_in_26as         boolean      not null default false,
  appears_in_26as_date    date,
  claimed_in_itr          boolean      not null default false,
  claimed_in_itr_date     date,

  notes                   text,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

create index idx_tds_receivable_tenant_status on public.tds_receivable (tenant_id, status);
create index idx_tds_receivable_tenant_fy     on public.tds_receivable (tenant_id, fiscal_year);
create index idx_tds_receivable_tenant_cust   on public.tds_receivable (tenant_id, customer_id);
create index idx_tds_receivable_invoice       on public.tds_receivable (invoice_id);

alter table public.tds_receivable enable row level security;

create policy tds_receivable_select_own_tenant on public.tds_receivable for select
  using (tenant_id = public.current_tenant_id());
create policy tds_receivable_insert_own_tenant on public.tds_receivable for insert
  with check (tenant_id = public.current_tenant_id());
create policy tds_receivable_update_own_tenant on public.tds_receivable for update
  using (tenant_id = public.current_tenant_id());
create policy tds_receivable_delete_own_tenant on public.tds_receivable for delete
  using (tenant_id = public.current_tenant_id());

create trigger trg_tds_receivable_updated_at
  before update on public.tds_receivable
  for each row execute function public.handle_updated_at();

alter table public.customers
  add column if not exists tan                  text,
  add column if not exists tds_default_section  text         default '194J',
  add column if not exists tds_default_rate_pct numeric(5,2) default 10.00;

commit;
