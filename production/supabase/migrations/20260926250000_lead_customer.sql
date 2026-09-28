-- ============================================================================
-- A lead can belong to an existing customer.
--
-- Pardeep, 26 Sep 2026: "lead existing customer ke liye bhi to ho sakti hai" — more seats,
-- a second product, a new software project. Until now a lead had only a typed company
-- name, so an upsell looked like a stranger and was re-keyed by hand.
--
-- leads.customer_id links the lead to the customer it came from. ON DELETE SET NULL: a
-- lead is not a financial record (contrast the RESTRICT keys of 20260926130000), so
-- deleting a customer leaves the lead standing with its typed company name.
-- A trigger refuses another company's customer id — the FK alone would accept one typed
-- into an API call.
-- ============================================================================

alter table public.leads
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

comment on column public.leads.customer_id is
  'Existing customer this lead is for (upsell / new project). NULL = a new business.';

create index if not exists leads_customer_idx on public.leads (tenant_id, customer_id) where customer_id is not null;

create or replace function public.tg_lead_customer_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.customer_id is not null and not exists (
    select 1 from public.customers c where c.id = new.customer_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'Customer not found for this company.';
  end if;
  return new;
end $$;

drop trigger if exists trg_lead_customer_same_tenant on public.leads;
create trigger trg_lead_customer_same_tenant
  before insert or update of customer_id on public.leads
  for each row execute function public.tg_lead_customer_same_tenant();
