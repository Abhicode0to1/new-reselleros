-- 0101: One-time / project sales (e.g. custom software) with milestone billing.
--
-- The rest of the app is subscription-reselling: quote → payment → subscription
-- → renewal. That does not fit a one-off project sold like a product (₹22L
-- custom software, billed in installments). Forcing it through the quote flow
-- would auto-create a bogus 1-year subscription + vendor PO.
--
-- This adds a first-class, self-contained path with NO subscription/PO/renewal:
--   project_sales      — the deal (customer, taxable value, GST, total)
--   project_milestones — the installment schedule (each = one GST-inclusive amount)
--   project_payments   — money received against the project
--
-- Revenue is recognised the normal way: raising a milestone's Tax Invoice writes
-- a row into the existing `invoices` table (so P&L picks it up on invoice date).
-- Receivable = project total − payments received.

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists public.project_sales (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  customer_id    uuid references public.customers(id) on delete set null,
  customer_name  text not null,
  title          text not null,
  description    text,
  sac_code       text not null default '998314',   -- IT software design & development
  gst_rate       integer not null default 18,
  inter_state    boolean not null default false,    -- CGST+SGST (false) vs IGST (true)
  taxable_amount integer not null,                  -- ₹, pre-GST contract value
  gst_amount     integer not null,                  -- ₹, GST on taxable
  total_amount   integer not null,                  -- ₹, taxable + GST
  status         text not null default 'active' check (status in ('active','completed','cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.project_milestones (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  project_id    uuid not null references public.project_sales(id) on delete cascade,
  seq           integer not null default 1,
  label         text not null,
  total_amount  integer not null,                   -- ₹, GST-inclusive amount due this installment
  due_date      date,
  status        text not null default 'pending' check (status in ('pending','invoiced','paid')),
  invoice_id    text references public.invoices(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists public.project_payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  project_id   uuid not null references public.project_sales(id) on delete cascade,
  milestone_id uuid references public.project_milestones(id) on delete set null,
  amount       integer not null,
  method       text,
  reference    text,
  received_at  date not null default current_date,
  bank_txn_id  uuid references public.bank_transactions(id) on delete set null,
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_project_milestones_project on public.project_milestones(project_id);
create index if not exists idx_project_payments_project    on public.project_payments(project_id);

-- ── RLS — tenant-scoped like every other table ───────────────────────────────
alter table public.project_sales      enable row level security;
alter table public.project_milestones enable row level security;
alter table public.project_payments   enable row level security;

drop policy if exists project_sales_tenant on public.project_sales;
create policy project_sales_tenant on public.project_sales
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists project_milestones_tenant on public.project_milestones;
create policy project_milestones_tenant on public.project_milestones
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists project_payments_tenant on public.project_payments;
create policy project_payments_tenant on public.project_payments
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

-- Allow reconciling a bank line to a project payment (new match type).
alter table public.bank_transactions drop constraint if exists bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array['payment','expense','vendor_bill','transfer','salary','project','manual']));

-- ── RPC: create a project + its milestones atomically ────────────────────────
create or replace function public.create_project_sale(
  p_customer_id   uuid,
  p_customer_name text,
  p_title         text,
  p_description   text,
  p_taxable       integer,
  p_gst_rate      integer,
  p_inter_state   boolean,
  p_milestones    jsonb        -- [{label, total_amount, due_date}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_gst    integer;
  v_total  integer;
  v_id     uuid;
  v_m      jsonb;
  v_seq    integer := 0;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  if coalesce(p_taxable, 0) <= 0 then raise exception 'Taxable amount must be > 0'; end if;

  v_gst   := round(p_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := p_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount)
  values
    (v_tenant, p_customer_id, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false), p_taxable, v_gst, v_total)
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb))
  loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (
      v_tenant, v_id, v_seq,
      coalesce(v_m->>'label', 'Milestone ' || v_seq),
      greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
      nullif(v_m->>'due_date','')::date
    );
  end loop;

  return v_id;
end;
$$;
grant execute on function public.create_project_sale(uuid, text, text, text, integer, integer, boolean, jsonb) to authenticated;

-- ── RPC: raise a Tax Invoice for one milestone ───────────────────────────────
-- Writes into the existing invoices table (quote_id NULL). GST is reverse-derived
-- from the GST-inclusive milestone total, using the project's gst_rate.
create or replace function public.raise_project_milestone_invoice(p_milestone_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ms     record;
  v_proj   record;
  v_id     text;
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_tenant is not null and v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_ms.invoice_id is not null then
    raise exception 'Invoice % already raised for this milestone', v_ms.invoice_id
      using errcode = 'unique_violation';
  end if;

  select * into v_proj from public.project_sales where id = v_ms.project_id;

  v_id := public.next_document_number('invoice', v_ms.tenant_id);
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, adjusted_advances, net_payable, quote_id)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount, 'pending'::invoice_status,
     current_date, coalesce(v_ms.due_date, current_date + 15), '[]'::jsonb, v_ms.total_amount, null);

  update public.project_milestones
     set invoice_id = v_id, status = 'invoiced'
   where id = p_milestone_id;

  return v_id;
end;
$$;
grant execute on function public.raise_project_milestone_invoice(uuid) to authenticated;

-- ── RPC: record a payment against a milestone (no subscription/PO) ───────────
create or replace function public.record_project_payment(
  p_milestone_id uuid,
  p_amount       integer,
  p_method       text,
  p_reference    text,
  p_received_at  date,
  p_bank_txn_id  uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_pay_id   uuid;
  v_paid     integer;
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_tenant is not null and v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be > 0'; end if;

  insert into public.project_payments
    (tenant_id, project_id, milestone_id, amount, method, reference, received_at, bank_txn_id)
  values
    (v_ms.tenant_id, v_ms.project_id, p_milestone_id, p_amount,
     nullif(trim(coalesce(p_method,'')),''), nullif(trim(coalesce(p_reference,'')),''),
     coalesce(p_received_at, current_date), p_bank_txn_id)
  returning id into v_pay_id;

  -- Milestone paid-in-full? → mark it (and its invoice) paid.
  select coalesce(sum(amount), 0) into v_paid
    from public.project_payments where milestone_id = p_milestone_id;
  if v_paid >= v_ms.total_amount then
    update public.project_milestones set status = 'paid' where id = p_milestone_id;
    if v_ms.invoice_id is not null then
      update public.invoices set status = 'paid'::invoice_status, paid_date = coalesce(p_received_at, current_date)
       where id = v_ms.invoice_id;
    end if;
  end if;

  -- Optionally link the real bank credit line so it's reconciled, not "unexplained".
  if p_bank_txn_id is not null then
    update public.bank_transactions
       set matched_to_type = 'project', matched_to_id = v_pay_id::text,
           matched_at = now(), match_confidence = 'manual'
     where id = p_bank_txn_id and tenant_id = v_ms.tenant_id;
  end if;

  return v_pay_id;
end;
$$;
grant execute on function public.record_project_payment(uuid, integer, text, text, date, uuid) to authenticated;
