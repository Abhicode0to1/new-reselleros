-- 20260817120100_instalment_invoice_credits_receipts
--
-- An instalment invoice must know what has already been paid against it.
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- With the sell path charging the FIRST instalment at quote acceptance, the money
-- for period 1 arrives BEFORE period 1's invoice exists. Without this, the billing
-- cron raises that invoice as 'pending' and the customer is chased — by the dunning
-- cron, by the portal's outstanding figure — for money they already sent on day one.
--
-- The invoice still has to be raised. Money received is not a tax invoice, and the
-- supply for period 1 genuinely happened. What changes is that it is raised already
-- settled instead of already overdue.
--
-- ─── WHAT COUNTS AS AVAILABLE ───────────────────────────────────────────────
--   received = everything received against the quote this subscription was sold on
--   applied  = what earlier instalments of THIS subscription already absorbed
--   available = received - applied
--
-- Subtracting `applied` is the part that matters. Without it, one ₹2,360 receipt
-- would mark every one of the twelve instalments paid as it came up, and a year of
-- supply would be collected once.
--
-- ─── PARTIAL COVER IS RECORDED, NOT ROUNDED AWAY ────────────────────────────
-- If what is available covers only part of the instalment, paid_amount carries it
-- and the invoice stays 'pending' for the rest. That happens for real: record_payment
-- derives mrr as round(line_amount / 12) (baseline.sql:4580), so a term that does not
-- divide evenly leaves the charged and invoiced figures a rupee or two apart. Crediting
-- what actually arrived, rather than assuming the two agree, is what keeps that from
-- becoming a balance nobody can clear.
--
-- HOW TO VERIFY (separate run from this DDL — CLAUDE.md §25.6):
--   begin;
--     -- with a payment already recorded against the subscription's quote:
--     select * from public.raise_subscription_billing('<instalment id>');
--     select id, status, paid_amount, net_payable from public.invoices order by created_at desc limit 1;
--     -- expect status 'paid' and paid_amount = amount when the receipt covers it
--   rollback;

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
  v_received integer := 0;
  v_applied  integer := 0;
  v_credit   integer := 0;
  v_status   invoice_status;
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

  /* Already billed. Ordinary answer, not an error — the cron retries. */
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

  -- ── What has already been paid towards this subscription ──────────────────
  if v_sub.quote_id is not null then
    select coalesce(sum(p.amount), 0) into v_received
      from public.payments p
     where p.quote_id = v_sub.quote_id
       and p.status   = 'received';
  end if;

  select coalesce(sum(i.paid_amount), 0) into v_applied
    from public.subscription_billings b
    join public.invoices i on i.id = b.invoice_id
   where b.subscription_id = v_b.subscription_id;

  v_credit := least(greatest(0, v_received - v_applied), v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  select state_code into v_cust_st from public.customers where id = v_sub.customer_id;
  select state_code into v_sell_st from public.tenants   where id = v_b.tenant_id;
  v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);

  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 0) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 0);

  /* ONE line, qty 1, rate = the whole instalment. Not qty = seats with a per-seat
     rate: an instalment of ₹2,000 over 3 seats is ₹666.67 each, and a tax invoice
     whose qty × rate does not equal its amount is wrong on its face. The seat count
     and service period go in the description, where CGST Rule 46 wants them. */
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
    invoice_date, due_date, paid_date,
    /* quote_id STAYS NULL — build-props.ts:69-71 prefers the quote for every amount
       it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would print
       ₹28,320 on it. The link lives on subscription_billings. */
    quote_id,
    net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, v_status,
    v_today, v_today + v_terms,
    case when v_status = 'paid' then v_today else null end,
    null,
    greatest(0, v_gross - v_credit), v_credit,
    v_b.taxable_amount, v_tax, v_b.tax_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$;

comment on function public.raise_subscription_billing(uuid) is
  'Raises the tax invoice for one subscription instalment, crediting money already received against the quote and not yet absorbed by an earlier instalment. Idempotent: an instalment already billed returns its existing invoice with already_raised = true, because the daily billing cron retries.';

commit;
