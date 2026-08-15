-- 0060_zero_amount_guards.sql
-- Defensive ₹0-amount guard on generate_invoice (audit bug #26).
-- (record_payment's matching guard #27 is in 0061.)
--
-- #26 generate_invoice: guard against issuing a ₹0 "paid" Tax Invoice (which
-- would burn a real INV serial for a zero-value supply). Guard is on GROSS
-- amount only — a quote fully settled by advances legitimately has net 0 with
-- gross > 0 and must still invoice. Verified: ₹0 quote rejected, full-payment
-- path still produces a paid invoice (no regression).

-- ── generate_invoice: ₹0 gross guard (#26) ─────────────────────────────────
create or replace function public.generate_invoice(p_quote_id text)
returns table(invoice_id text, net_payable integer, total_advances integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote   record;
  v_adv     jsonb;
  v_total   integer;
  v_first   timestamptz;
  v_id      text;
  v_gross   integer;
  v_net     integer;
  v_status  invoice_status;
  v_today   date := current_date;
begin
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id
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
    adjusted_advances, net_payable, first_advance_at, quote_id
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    v_today, v_today + 30, case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id
  );

  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  return query select v_id, v_net, v_total;
end;
$$;

grant execute on function public.generate_invoice(text) to authenticated, service_role;
