-- 20260817110100_raise_subscription_billing
--
-- Turn ONE instalment into ONE tax invoice, atomically.
--
-- Modelled on generate_invoice (0058) — same tenant check, same taxable/tax split,
-- same inter_state derivation, same next_document_number call. The differences are
-- all consequences of the fact that the money comes from an INSTALMENT and not from
-- a quote, and each one is commented where it appears.
--
-- ─── IT IS IDEMPOTENT, AND THAT IS NOT A CONVENIENCE ────────────────────────
-- An already-raised instalment RETURNS its invoice rather than raising an error.
-- A daily cron retries: it gets re-run after a partial failure, it gets triggered
-- twice, Cloud Scheduler delivers at-least-once. If the second call errored, the
-- honest handling would be to swallow the error — and code that swallows errors
-- around invoice creation eventually swallows a real one. Returning the existing
-- invoice makes "already billed" an ordinary answer instead of an exception.
--
-- The row is locked FOR UPDATE first, so two concurrent calls cannot both find
-- invoice_id null and both allocate a number.
--
-- ─── WHY invoice_date IS TODAY AND NOT bill_on ──────────────────────────────
-- A GST series must be consecutive (CGST Rule 46). If the cron misses a day and
-- catches up, dating the invoice bill_on would issue a NEWER number with an OLDER
-- date — a broken series, and exactly what an audit looks for.
--
-- The instalment's service period is not lost: it is printed on the line item. That
-- is where a service period belongs on a tax invoice anyway.

begin;

create or replace function public.raise_subscription_billing(p_billing_id uuid)
returns table(invoice_id text, gross integer, already_raised boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_b        record;
  v_sub      record;
  v_id       text;
  v_gross    integer;
  v_tax      integer;
  v_cust_st  text;
  v_sell_st  text;
  v_inter    boolean;
  v_lines    jsonb;
  v_terms    integer := 0;
  v_today    date := current_date;
  v_existing integer;
begin
  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_b.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — see the header. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

  v_tax   := round(v_b.taxable_amount * v_b.tax_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  /* Place of supply — same derivation as generate_invoice. */
  select state_code into v_cust_st from public.customers where id = v_sub.customer_id;
  select state_code into v_sell_st from public.tenants   where id = v_b.tenant_id;
  v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);

  /* Payment terms come from the quote the subscription was sold on, when there is
     one. A subscription has no terms of its own. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 0) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 0);

  /* ONE line, qty 1, rate = the whole instalment.
     Not qty = seats with a per-seat rate: an instalment of ₹2,000 over 3 seats is
     ₹666.67 each, and a tax invoice whose qty × rate does not equal its amount is
     wrong on its face. The seat count and the service period go in the description,
     which is where CGST Rule 46 wants them. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'instalment-' || v_b.period_index::text,
    'name',        v_sub.plan,
    'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                   || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                   || to_char(v_b.period_end,   'DD Mon YYYY'),
    'qty',         1,
    'rate',        v_b.taxable_amount,
    'cost',        0
  ));

  v_id := public.next_document_number('invoice', v_b.tenant_id);
  if v_id is null then
    raise exception 'Could not allocate an invoice number for instalment %', p_billing_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date,
    /* quote_id STAYS NULL. lib/pdf/build-props.ts:69-71 prefers the quote for every
       amount it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would
       print ₹28,320 on this invoice. The link lives on subscription_billings. */
    quote_id,
    net_payable, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, 'pending',
    v_today, v_today + v_terms,
    null,
    /* No advance adjustment. Advances are settled against the quote they were paid
       against; an instalment is billed as it falls due. */
    v_gross, v_b.taxable_amount, v_tax, v_b.tax_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$;

comment on function public.raise_subscription_billing(uuid) is
  'Raises the tax invoice for one subscription instalment. Idempotent: an instalment already billed returns its existing invoice with already_raised = true rather than erroring, because the daily cron retries.';

revoke all on function public.raise_subscription_billing(uuid) from public;
grant execute on function public.raise_subscription_billing(uuid) to authenticated, service_role;

commit;
