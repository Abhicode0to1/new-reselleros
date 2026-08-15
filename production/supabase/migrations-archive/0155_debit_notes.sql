-- 0155 — Debit Notes (CGST Section 34) — the mirror of the credit note.
--
-- A debit note INCREASES a previously-issued tax invoice — when the original
-- undercharged (wrong lower rate/qty), or an additional charge / price
-- escalation applies to an already-invoiced supply. It is its own GST document
-- (DN series), references the original invoice, carries a frozen GST split that
-- mirrors the invoice's head + rate (an export/zero-rated invoice → zero-rated
-- debit note), and RAISES what the customer owes. Unlike a credit note there is
-- no upper cap — a debit note can add any positive amount. The original invoice
-- is never edited.

-- A debit note legitimately raises net_payable ABOVE the original invoice
-- amount, so the old "net_payable <= amount" upper bound is relaxed to a lower
-- bound only. (Base invoices are still generated with net_payable <= amount.)
alter table public.invoices drop constraint if exists invoices_net_payable_range;
alter table public.invoices add constraint invoices_net_payable_range
  check (net_payable is null or net_payable >= 0);

create table if not exists public.debit_notes (
  id             text primary key,                                   -- DN-YYYY-YY-NNNN
  tenant_id      uuid not null references public.tenants(id)   on delete cascade,
  invoice_id     text not null references public.invoices(id)  on delete restrict,
  customer_id    uuid references public.customers(id)          on delete set null,
  customer_name  text,
  debit_date     date not null default current_date,
  reason_code    text not null default 'other'
                 check (reason_code in ('undercharge','additional_charge','price_escalation','other')),
  reason         text,
  amount         integer not null check (amount > 0),                -- gross ₹ (incl tax) being added
  taxable_value  integer not null,
  tax_amount     integer not null,
  tax_rate       integer not null,
  inter_state    boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid
);

alter table public.debit_notes enable row level security;

create policy debit_notes_select_own_tenant on public.debit_notes
  for select using (tenant_id = public.current_tenant_id());
create policy debit_notes_insert_own_tenant on public.debit_notes
  for insert with check (tenant_id = public.current_tenant_id());
create policy debit_notes_update_own_tenant on public.debit_notes
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy debit_notes_delete_own_tenant on public.debit_notes
  for delete using (tenant_id = public.current_tenant_id());
create policy debit_notes_service_role_all on public.debit_notes
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists debit_notes_tenant_invoice_idx on public.debit_notes (tenant_id, invoice_id);
create index if not exists debit_notes_tenant_date_idx    on public.debit_notes (tenant_id, debit_date);

grant select, insert, update, delete on public.debit_notes to authenticated;

-- ── Atomic issue: allocate DN number + freeze GST split + raise net owed ─────
create or replace function public.issue_debit_note(
  p_invoice_id   text,
  p_gross_amount integer,
  p_reason_code  text default 'other',
  p_reason       text default null,
  p_notes        text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inv           record;
  v_is_service    boolean;
  v_caller_tenant uuid;
  v_rate          integer;
  v_taxable       integer;
  v_tax           integer;
  v_dn_id         text;
  v_new_net       integer;
begin
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Debit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  -- GST split mirrors the invoice's rate + head. rate 0 (export/zero-rated) → tax 0.
  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  v_dn_id := public.next_document_number('debit_note', v_inv.tenant_id);
  if v_dn_id is null then raise exception 'Could not allocate a debit note number'; end if;

  insert into public.debit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, debit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_dn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, current_date,
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  -- Raise what the customer owes on this invoice. The frozen amount/taxable/tax
  -- on the invoice are NOT touched (immutable); net_payable is the running balance.
  v_new_net := coalesce(v_inv.net_payable, v_inv.amount) + p_gross_amount;
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'debit_note_id',   v_dn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net
  );
end;
$function$;

grant execute on function public.issue_debit_note(text, integer, text, text, text) to authenticated;
