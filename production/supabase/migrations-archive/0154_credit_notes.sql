-- 0154 — Credit Notes (CGST Section 34).
--
-- A credit note REDUCES a previously-issued tax invoice — for a post-sale
-- discount, an over-billing, cancelled/returned service, or a mid-term seat
-- reduction. It is its own GST document (CN series), references the original
-- invoice, carries a frozen GST split that MIRRORS the invoice's head + rate
-- (so an export/zero-rated invoice yields a zero-rated credit note), and lowers
-- what the customer still owes. The original invoice's frozen amounts are never
-- edited (immutable — an issued invoice cannot be altered); the credit note is
-- a separate offsetting document.

create table if not exists public.credit_notes (
  id             text primary key,                                   -- CN-YYYY-YY-NNNN (next_document_number)
  tenant_id      uuid not null references public.tenants(id)   on delete cascade,
  invoice_id     text not null references public.invoices(id)  on delete restrict,
  customer_id    uuid references public.customers(id)          on delete set null,
  customer_name  text,
  credit_date    date not null default current_date,
  reason_code    text not null default 'other'
                 check (reason_code in ('overbilling','seats_reduced','discount','cancellation','return','other')),
  reason         text,                                                -- free-text detail
  amount         integer not null check (amount > 0),                 -- gross ₹ (incl tax) being credited
  taxable_value  integer not null,                                    -- frozen GST split (mirrors the invoice)
  tax_amount     integer not null,
  tax_rate       integer not null,
  inter_state    boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid
);

alter table public.credit_notes enable row level security;

create policy credit_notes_select_own_tenant on public.credit_notes
  for select using (tenant_id = public.current_tenant_id());
create policy credit_notes_insert_own_tenant on public.credit_notes
  for insert with check (tenant_id = public.current_tenant_id());
create policy credit_notes_update_own_tenant on public.credit_notes
  for update using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id());
create policy credit_notes_delete_own_tenant on public.credit_notes
  for delete using (tenant_id = public.current_tenant_id());
create policy credit_notes_service_role_all on public.credit_notes
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

create index if not exists credit_notes_tenant_invoice_idx on public.credit_notes (tenant_id, invoice_id);
create index if not exists credit_notes_tenant_date_idx    on public.credit_notes (tenant_id, credit_date);

grant select, insert, update, delete on public.credit_notes to authenticated;

-- ── Atomic issue: allocate CN number + freeze GST split + reduce net owed ────
create or replace function public.issue_credit_note(
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
  v_inv             record;
  v_is_service      boolean;
  v_caller_tenant   uuid;
  v_already         integer;
  v_max_creditable  integer;
  v_rate            integer;
  v_taxable         integer;
  v_tax             integer;
  v_cn_id           text;
  v_new_net         integer;
begin
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Credit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  -- Can't credit more than the invoice value, net of any prior credit notes.
  select coalesce(sum(amount), 0) into v_already from public.credit_notes where invoice_id = p_invoice_id;
  v_max_creditable := coalesce(v_inv.amount, 0) - v_already;
  if p_gross_amount > v_max_creditable then
    raise exception 'Credit % exceeds the creditable balance % on invoice %',
      p_gross_amount, v_max_creditable, p_invoice_id using errcode = 'check_violation';
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

  v_cn_id := public.next_document_number('credit_note', v_inv.tenant_id);
  if v_cn_id is null then raise exception 'Could not allocate a credit note number'; end if;

  insert into public.credit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, credit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_cn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, current_date,
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  -- Lower what the customer still owes on this invoice (floored at 0). The
  -- frozen amount/taxable/tax on the invoice are NOT touched (immutable).
  v_new_net := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - p_gross_amount);
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'credit_note_id',  v_cn_id,
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

grant execute on function public.issue_credit_note(text, integer, text, text, text) to authenticated;
