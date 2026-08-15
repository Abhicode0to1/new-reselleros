-- ============================================================
-- ResellerOS — initial multi-tenant schema
-- Migration: 0001_init.sql
-- ============================================================
-- Every domain table has tenant_id + RLS (added in 0002_rls.sql).
-- Money stored as integer rupees (NOT paise) to match prototype.
-- Production would use paise — convert in app layer.
-- ============================================================

-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ============================================================
-- tenants  (each row = one reseller business)
-- ============================================================
create table public.tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  gstin        text,
  state        text,
  state_code   text,
  address      text,
  email        text not null,
  phone        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.tenants is 'Each reseller business is one tenant. Multi-tenant isolation via tenant_id + RLS.';

-- ============================================================
-- users  (extends auth.users with tenant + role)
-- ============================================================
create type public.user_role as enum ('owner', 'sales', 'accountant', 'support');

create table public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  email        text not null,
  full_name    text,
  initials     text,
  role         public.user_role not null default 'sales',
  color        text default 'ink',
  avatar_url   text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index idx_users_tenant on public.users(tenant_id);

-- Helper: get the current authenticated user's tenant_id
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.users where id = auth.uid();
$$;

comment on function public.current_tenant_id() is
  'Returns tenant_id for the authenticated user. Used in RLS policies.';

-- ============================================================
-- customers  (end-customers of resellers)
-- ============================================================
create table public.customers (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  name                 text not null,
  domain               text,
  gstin                text,
  state                text,
  state_code           text,
  health               smallint default 70 check (health between 0 and 100),
  contact_name         text,
  contact_title        text,
  contact_email        text,
  contact_phone        text,
  account_manager_id   uuid references public.users(id) on delete set null,
  since                date default current_date,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index idx_customers_tenant on public.customers(tenant_id);
create index idx_customers_domain on public.customers(tenant_id, domain);

-- ============================================================
-- items  (vendor product catalog — per tenant)
-- ============================================================
create type public.vendor as enum ('google', 'microsoft', 'zoho', 'other');

create table public.items (
  id           text primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  vendor       public.vendor not null,
  hsn          text default '998313',
  msrp         integer not null,        -- ₹/seat/month (customer price)
  wholesale    integer not null,        -- ₹/seat/month (your cost from vendor)
  margin_pct   smallint generated always as
                 (case when msrp > 0 then ((msrp - wholesale) * 100 / msrp) else 0 end) stored,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index idx_items_tenant on public.items(tenant_id);

-- ============================================================
-- leads
-- ============================================================
create type public.lead_stage as enum ('new', 'contact', 'demo', 'trial', 'quote', 'won', 'lost');

create table public.leads (
  id              text primary key,           -- L1, L2, etc. (or uuid in production)
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  company         text not null,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  plan            text,
  seats           integer,
  value           integer,                    -- ₹ expected deal size
  stage           public.lead_stage not null default 'new',
  owner_id        uuid references public.users(id) on delete set null,
  source          text,                       -- 'buy-workspace-v2', 'manual', 'csv', etc.
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_leads_tenant_stage on public.leads(tenant_id, stage);

-- ============================================================
-- quotes
-- ============================================================
create type public.quote_status as enum ('draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired');

create table public.quotes (
  id            text primary key,           -- Q-2026-0042
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete set null,
  customer_name text not null,              -- denormalized for display
  lead_id       text references public.leads(id) on delete set null,
  plan          text,
  seats         integer,
  amount        integer,                    -- annual total ₹
  status        public.quote_status not null default 'draft',
  owner_id      uuid references public.users(id) on delete set null,
  created_date  date not null default current_date,
  expires_date  date,
  pdf_url       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_quotes_tenant on public.quotes(tenant_id);
create index idx_quotes_status on public.quotes(tenant_id, status);

-- ============================================================
-- invoices
-- ============================================================
create type public.invoice_status as enum ('draft', 'pending', 'paid', 'overdue', 'void');

create table public.invoices (
  id              text primary key,         -- INV-2026-0089
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  customer_id     uuid references public.customers(id) on delete set null,
  customer_name   text not null,
  amount          integer not null,         -- total ₹
  status          public.invoice_status not null default 'pending',
  invoice_date    date not null default current_date,
  due_date        date,
  paid_date       date,
  overdue_days    integer default 0,
  razorpay_id     text,                     -- payment reference
  gst_irn         text,                     -- GST e-invoice IRN
  pdf_url         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_invoices_tenant_status on public.invoices(tenant_id, status);

-- ============================================================
-- subscriptions
-- ============================================================
create type public.sub_status as enum ('active', 'paused', 'expired', 'cancelled');

create table public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete cascade,
  customer_name text not null,
  domain        text,
  plan          text not null,
  vendor        public.vendor not null,
  seats         integer not null,
  used          integer default 0,
  mrr           integer not null,
  start_date    date,
  renewal_date  date,
  status        public.sub_status not null default 'active',
  is_urgent     boolean default false,      -- expiring soon flag
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_subs_tenant on public.subscriptions(tenant_id);
create index idx_subs_renewal on public.subscriptions(tenant_id, renewal_date);

-- ============================================================
-- Auto-update updated_at on row updates
-- ============================================================
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_tenants_updated_at      before update on public.tenants      for each row execute function public.handle_updated_at();
create trigger trg_customers_updated_at    before update on public.customers    for each row execute function public.handle_updated_at();
create trigger trg_leads_updated_at        before update on public.leads        for each row execute function public.handle_updated_at();
create trigger trg_quotes_updated_at       before update on public.quotes       for each row execute function public.handle_updated_at();
create trigger trg_invoices_updated_at     before update on public.invoices     for each row execute function public.handle_updated_at();
create trigger trg_subscriptions_updated_at before update on public.subscriptions for each row execute function public.handle_updated_at();
