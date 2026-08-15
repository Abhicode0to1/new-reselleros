-- ============================================================================
-- 0172 — Customer archive (Zoho-style "Mark as Inactive").
--
-- A customer that can't be deleted (has invoices / payments / subscriptions —
-- money history is retained for GST/audit) can instead be ARCHIVED: hidden from
-- the active book of business without deleting any records. Fully reversible
-- (Reactivate). Default true so every existing customer stays active.
-- ============================================================================
alter table public.customers
  add column if not exists is_active boolean not null default true;

comment on column public.customers.is_active is
  'Zoho-style active flag. false = archived/inactive: hidden from the default customers list but all invoices/payments/GST records are retained. Reversible.';

create index if not exists customers_tenant_active_idx
  on public.customers (tenant_id, is_active);
