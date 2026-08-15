-- 0141: customer_credits — track money received ABOVE what a quote/invoice
-- expected (an overpayment) as an advance credit for that customer, instead of
-- silently absorbing it (record_payment floors outstanding at 0, so the excess
-- used to vanish). An 'open' credit can later be adjusted against the customer's
-- next bill (or refunded). Recorded best-effort by the record-payment flow.

create table if not exists public.customer_credits (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  amount            integer not null check (amount > 0),   -- ₹, always positive
  source            text not null default 'overpayment',
  source_payment_id uuid,
  source_quote_id   text,
  note              text,
  status            text not null default 'open' check (status in ('open','used','refunded')),
  created_at        timestamptz not null default now()
);

alter table public.customer_credits enable row level security;

create policy customer_credits_select_own_tenant on public.customer_credits
  for select using (tenant_id = public.current_tenant_id());
create policy customer_credits_insert_own_tenant on public.customer_credits
  for insert with check (tenant_id = public.current_tenant_id());
create policy customer_credits_update_own_tenant on public.customer_credits
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy customer_credits_delete_own_tenant on public.customer_credits
  for delete using (tenant_id = public.current_tenant_id());
create policy customer_credits_service_role_all on public.customer_credits
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists customer_credits_tenant_customer_status_idx
  on public.customer_credits (tenant_id, customer_id, status);

grant select, insert, update, delete on public.customer_credits to authenticated;
