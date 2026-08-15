-- 0043_cross_tenant_invoice_mirror.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Cross-tenant invoice → vendor bill mirroring (Slice 2)
--
-- When a distributor tenant (Excel Tech) creates an invoice for a customer
-- that's linked to a child tenant (Anutech), automatically materialise a
-- matching vendor_bill in the child's books. Saves double data entry —
-- one invoice on the parent side = one expense on the child side.
--
--   customers.linked_tenant_id        = uuid  → links this customer record
--                                               to another tenant (must be
--                                               a declared child of the
--                                               customer's tenant)
--   vendor_bills.source_tenant_invoice_id = text → on a child-side bill, the
--                                                  parent's invoice id this
--                                                  row mirrors. Idempotency
--                                                  + audit trail.
--
-- Mirror logic (SECURITY DEFINER AFTER INSERT trigger):
--   1. Look up invoice.customer_id → customers.linked_tenant_id
--   2. If null → no-op
--   3. Verify the linked tenant is actually a child of the invoice's tenant
--      (otherwise reject — prevents unauthorised cross-tenant write)
--   4. Insert vendor_bill in the child's tenant with:
--        vendor_name = parent tenant.name
--        bill_no     = parent invoice.id
--        bill_date   = invoice_date
--        due_date    = due_date
--        line_items  = single-row summary
--        total       = invoice.amount
--        GST split   = 18% IGST (inter-state safe default — user can adjust)
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.customers
  add column if not exists linked_tenant_id uuid
    references public.tenants(id) on delete set null;

alter table public.vendor_bills
  add column if not exists source_tenant_invoice_id text;

-- A child tenant can have at most one bill per parent-invoice (idempotency
-- across re-runs / retries of the trigger).
create unique index if not exists ux_vendor_bills_source_tenant_invoice
  on public.vendor_bills(tenant_id, source_tenant_invoice_id)
  where source_tenant_invoice_id is not null;

create index if not exists idx_customers_linked_tenant
  on public.customers(linked_tenant_id)
  where linked_tenant_id is not null;

-- ─── Trigger function ──────────────────────────────────────────────────────
create or replace function public.tg_mirror_invoice_to_child_vendor_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_linked_tenant uuid;
  v_parent_tenant tenants%rowtype;
  v_parent_state  text;
  v_child_state   text;
  v_subtotal      integer;
  v_igst          integer;
  v_cgst          integer;
  v_sgst          integer;
  v_inter_state   boolean;
begin
  -- 1. Customer linked to another tenant?
  if NEW.customer_id is null then
    return NEW;
  end if;

  select linked_tenant_id into v_linked_tenant
  from public.customers
  where id = NEW.customer_id
    and tenant_id = NEW.tenant_id;

  if v_linked_tenant is null then
    return NEW;
  end if;

  -- 2. Validate: linked tenant must be a declared child of the invoice's
  --    tenant — otherwise reject silently. Prevents Excel Tech from
  --    accidentally mirroring into a tenant it doesn't actually distribute to.
  if not exists (
    select 1 from public.tenants
    where id = v_linked_tenant
      and parent_tenant_id = NEW.tenant_id
  ) then
    return NEW;
  end if;

  -- 3. Skip if a bill for this invoice already exists (idempotency)
  if exists (
    select 1 from public.vendor_bills
    where tenant_id = v_linked_tenant
      and source_tenant_invoice_id = NEW.id
  ) then
    return NEW;
  end if;

  -- 4. Fetch parent tenant display fields + state codes for GST split
  select * into v_parent_tenant from public.tenants where id = NEW.tenant_id;
  v_parent_state := v_parent_tenant.state_code;
  select state_code into v_child_state from public.tenants where id = v_linked_tenant;

  v_inter_state := v_parent_state is null or v_child_state is null or v_parent_state <> v_child_state;

  -- Assume invoice.amount is the total (post-tax) at the standard 18% rate.
  -- Reverse-derive subtotal + GST split; child can fine-tune in vendor_bill detail.
  v_subtotal := round(NEW.amount::numeric / 1.18)::integer;
  if v_inter_state then
    v_igst := NEW.amount - v_subtotal;
    v_cgst := 0;
    v_sgst := 0;
  else
    v_igst := 0;
    v_cgst := round((NEW.amount - v_subtotal)::numeric / 2)::integer;
    v_sgst := (NEW.amount - v_subtotal) - v_cgst;
  end if;

  -- 5. Insert the mirrored vendor bill
  insert into public.vendor_bills (
    id, tenant_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
    category, line_items, subtotal, cgst, sgst, igst, total, status,
    paid_amount, notes, source_tenant_invoice_id
  ) values (
    'VB-PARTNER-' || NEW.id,
    v_linked_tenant,
    v_parent_tenant.name,
    v_parent_tenant.gstin,
    NEW.id,                                  -- bill_no = parent invoice id
    NEW.invoice_date,
    NEW.due_date,
    'cloud_subscriptions',
    jsonb_build_array(jsonb_build_object(
      'description', 'Wholesale supply against invoice ' || NEW.id,
      'quantity',    1,
      'rate',        v_subtotal,
      'amount',      v_subtotal
    )),
    v_subtotal,
    v_cgst,
    v_sgst,
    v_igst,
    NEW.amount,
    'unpaid',
    0,
    'Auto-imported from ' || v_parent_tenant.name || ' (your distributor).',
    NEW.id
  );

  return NEW;
end $$;

revoke all on function public.tg_mirror_invoice_to_child_vendor_bill() from public;

drop trigger if exists trg_mirror_invoice_to_child on public.invoices;
create trigger trg_mirror_invoice_to_child
  after insert on public.invoices
  for each row
  execute function public.tg_mirror_invoice_to_child_vendor_bill();

commit;
