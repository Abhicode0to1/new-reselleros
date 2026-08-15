-- 0158 — create_direct_invoice: raise a one-off GST invoice straight against a
-- customer (setup fee, ad-hoc service) without the manual quote → invoice steps.
--
-- Keeps the "every invoice has a quote behind it" model: it creates a one-off
-- quote (is_one_off = true, so its payment never spins up a subscription — 0157)
-- then calls the battle-tested generate_invoice() to freeze the GST split, allocate
-- the invoice number, and set net_payable (net-30, status pending). Export customers
-- (country ≠ India) are zero-rated exactly like the quote builder.
--
-- Atomic: quote insert + generate_invoice run in one SECURITY DEFINER transaction.

create or replace function public.create_direct_invoice(
  p_customer_id uuid,
  p_line_items  jsonb,
  p_notes       text default null
) returns table(invoice_id text, quote_id text, net_payable integer, tax_rate integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_is_svc   boolean := auth.role() = 'service_role';
  v_cust     record;
  v_export   boolean;
  v_rate     integer;
  v_subtotal integer;
  v_gross    integer;
  v_qid      text;
  v_inv      record;
begin
  if not v_is_svc and v_tenant is null then raise exception 'No tenant context'; end if;
  if p_customer_id is null then raise exception 'Customer required'; end if;
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust
    from public.customers c where c.id = p_customer_id;
  if not found then raise exception 'Customer not found'; end if;
  if not v_is_svc and v_cust.tenant_id is distinct from v_tenant then
    raise exception 'Customer is not in the caller''s tenant';
  end if;
  v_tenant := v_cust.tenant_id;

  -- Export? mirror isExportSupply(): blank / India = domestic, anything else = export.
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case when v_export then 0 else 18 end;

  -- Ex-GST subtotal = Σ(qty × rate). Gross adds GST (export: rate 0 → gross = subtotal).
  select coalesce(sum( coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0) ), 0)
    into v_subtotal
    from jsonb_array_elements(p_line_items) li;
  if v_subtotal <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gross := v_subtotal + round(v_subtotal * v_rate / 100.0)::int;

  v_qid := public.next_document_number('quote', v_tenant);
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, created_date, notes
  ) values (
    v_qid, v_tenant, p_customer_id, v_cust.name, v_gross, v_subtotal, v_rate, 0,
    p_line_items, 'accepted', 'awaiting', true, current_date, p_notes
  );

  select gi.invoice_id, gi.net_payable into v_inv
    from public.generate_invoice(v_qid) gi;

  return query select v_inv.invoice_id, v_qid, v_inv.net_payable, v_rate;
end;
$$;

grant execute on function public.create_direct_invoice(uuid, jsonb, text) to authenticated;
