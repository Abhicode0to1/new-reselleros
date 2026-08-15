-- ============================================================================
-- 0169 — Invoice DUE DATE defaults to the INVOICE DATE (Due on Receipt).
--
-- Was: due_date fell back to invoice_date + 30 (generate_invoice) / + 15
-- (project milestones) when no explicit term was set. Owner wants the default
-- to be the invoice date itself, while staying editable:
--   • generate_invoice          : coalesce(payment_terms_days, 30) → , 0
--   • raise_project_milestone…  : coalesce(due_date, inv_date + 15) → , inv_date
--
-- Editability is UNCHANGED and already end-to-end:
--   • Subscription/service invoices → quote-builder "Terms" dropdown
--     (Due on receipt / Net 15 / 30 / 45) writes quotes.payment_terms_days.
--   • A customer's saved payment_terms_days (0164) still OVERRIDES the fallback.
--   • Project invoices → the milestone's own due_date still wins.
-- Only the *fallback* changes. Everything else in both functions is byte-identical
-- to 0163 / 0116.
-- ============================================================================

-- ── generate_invoice: fallback 30 → 0 (line vs 0163: due_date coalesce only) ──
create or replace function public.generate_invoice(p_quote_id text)
 returns table(invoice_id text, net_payable integer, total_advances integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := current_date;
  v_taxable   integer;
  v_tax       integer;
  v_rate      integer;
  v_cust_st   text;
  v_sell_st   text;
  v_inter     boolean;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id,
         q.subtotal, q.discount_pct, q.tax_rate, q.payment_terms_days
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;

  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_quote.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.invoice_id is not null then
    raise exception 'Invoice % already exists for quote %', v_quote.invoice_id, p_quote_id
      using errcode = 'unique_violation';
  end if;

  v_gross := coalesce(v_quote.amount, 0);
  if v_gross <= 0 then
    raise exception 'Quote % has no amount — cannot generate a zero-value tax invoice', p_quote_id
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_quote.tax_rate, 18);
  if v_quote.subtotal is not null then
    v_taxable := v_quote.subtotal - round(v_quote.subtotal * coalesce(v_quote.discount_pct, 0) / 100.0);
  else
    v_taxable := round(v_gross * 100.0 / (100 + v_rate));
  end if;
  v_tax := v_gross - v_taxable;

  select state_code into v_cust_st from public.customers where id = v_quote.customer_id;
  select state_code into v_sell_st from public.tenants   where id = v_quote.tenant_id;
  v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);

  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  v_id := public.next_document_number('invoice', v_quote.tenant_id);
  if v_id is null then
    raise exception 'Could not allocate invoice number for quote %', p_quote_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date, razorpay_id,
    adjusted_advances, net_payable, first_advance_at, quote_id,
    taxable_value, tax_amount, tax_rate, inter_state
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    v_today, v_today + coalesce(v_quote.payment_terms_days, 0), case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id,
    v_taxable, v_tax, v_rate, v_inter
  );

  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  return query select v_id, v_net, v_total;
end;
$function$;

grant execute on function public.generate_invoice(text) to authenticated, service_role;

-- ── raise_project_milestone_invoice: milestone-due fallback + 15 → + 0 ──
create or replace function public.raise_project_milestone_invoice(p_milestone_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_proj     record;
  v_id       text;
  v_paid     integer;
  v_full     boolean;
  v_pay_date date;
  v_inv_date date;
  v_rate     integer;
  v_taxable  integer;
  v_tax      integer;
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

  select coalesce(sum(amount), 0), min(received_at)
    into v_paid, v_pay_date
    from public.project_payments where milestone_id = p_milestone_id;
  v_full     := v_paid >= v_ms.total_amount;
  v_inv_date := case when v_full and v_pay_date is not null then v_pay_date else current_date end;

  -- GST breakdown — milestone total is GST-inclusive; reverse-derive at the
  -- project's rate. This also makes the customer-facing PDF show real GST.
  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(v_ms.total_amount * 100.0 / (100 + v_rate));
  v_tax     := v_ms.total_amount - v_taxable;

  v_id := public.next_document_number('invoice', v_ms.tenant_id);
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, coalesce(v_ms.due_date, v_inv_date),
     case when v_full then v_inv_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false));

  update public.project_milestones
     set invoice_id = v_id,
         status = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;

grant execute on function public.raise_project_milestone_invoice(uuid) to authenticated;
