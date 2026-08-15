-- 0080_customer_number_autoassign.sql
-- Give EVERY customer a stable, readable customer number (C-00001) so it can
-- serve as the external `billing_customer_id` for integrations (DSP support
-- platform) — and generally because a billing app should number its customers.
--
-- 0071 added `customer_number` as a free-text external ref (Zoho import). It's
-- mostly NULL. This migration:
--   1. a per-tenant, non-fiscal, race-safe counter (UPSERT row-lock)
--   2. a BEFORE INSERT trigger that fills customer_number when blank
--   3. backfills every existing blank customer_number
-- Imported non-blank values (e.g. "CUS-00001") are preserved untouched.

-- 1. Per-tenant counter (never resets — customer numbers are permanent).
create table if not exists public.customer_number_seq (
  tenant_id   uuid primary key references public.tenants(id) on delete cascade,
  last_number integer not null default 0
);
alter table public.customer_number_seq enable row level security;
-- Mutated only via the SECURITY DEFINER function below — no authenticated policy.
drop policy if exists customer_number_seq_service on public.customer_number_seq;
create policy customer_number_seq_service on public.customer_number_seq
  to service_role using (true) with check (true);

-- 2. Atomic next-number. UPSERT row-lock → two concurrent inserts can't collide.
create or replace function public.next_customer_number(p_tenant uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  insert into public.customer_number_seq (tenant_id, last_number)
  values (p_tenant, 1)
  on conflict (tenant_id)
    do update set last_number = customer_number_seq.last_number + 1
  returning last_number into v_n;
  return 'C-' || lpad(v_n::text, 5, '0');
end;
$$;

-- 3. Auto-assign on insert when blank (import path that sets it explicitly wins).
create or replace function public.assign_customer_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.customer_number is null or new.customer_number = '' then
    new.customer_number := public.next_customer_number(new.tenant_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_customer_number on public.customers;
create trigger trg_assign_customer_number
  before insert on public.customers
  for each row execute function public.assign_customer_number();

-- 4. Backfill existing blanks, per tenant, oldest first (stable numbering).
do $$
declare
  r record;
begin
  for r in
    select id, tenant_id
    from public.customers
    where customer_number is null or customer_number = ''
    order by tenant_id, created_at, id
  loop
    update public.customers
    set customer_number = public.next_customer_number(r.tenant_id)
    where id = r.id;
  end loop;
end;
$$;
