-- 0057: subscription MRR should be EX-GST (net recurring revenue), not GST-inclusive
--
-- record_payment derived sub.mrr from quote.amount / term, but `amount` is the
-- GST-INCLUSIVE payable. So every auto-created / renewed subscription stored a
-- GST-inflated MRR (e.g. Enterprise ×16 → ₹45,312 = ₹38,400 × 1.18), inflating
-- the dashboard MRR/ARR by ~18%. MRR is net recurring REVENUE — GST is a
-- pass-through collected for the government, not the reseller's revenue (bug #36,
-- Pardeep confirmed ex-GST). Fix: derive MRR from quote.subtotal (the ex-GST
-- taxable), with coalesce(subtotal, amount) as a safe fallback. add-seats already
-- scales MRR proportionally (basis-neutral), so once subs are ex-GST it stays
-- ex-GST. Only the two MRR spots change; everything else is identical to 0056.
--
-- A one-time backfill of existing GST-inclusive subs (mrr = round(mrr/1.18)) is
-- applied SEPARATELY (not in this migration) so a migration replay can't double-
-- divide already-correct rows.

create or replace function public.record_payment(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;
  v_is_service_role       boolean;
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;
  v_payment_id            uuid;
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;
  v_domain                text;
  v_subscription_created  boolean := false;
  v_new_sub_id            uuid;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;
  v_is_renewal_quote      boolean := false;
  v_renewal_sub           record;
  v_renewal_rolled_forward boolean := false;
  v_extension_months      integer;
  v_new_mrr               integer;
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
  v_po_id                 text := null;
  v_po_created            boolean := false;
  v_unit_wholesale_pm     integer;
  v_total_wholesale       integer;
  v_po_seats              integer;
  v_po_months             integer;
  v_po_plan               text;
  v_po_vendor             public.vendor;
  v_po_sub_id             uuid;
  v_was_trial             boolean := false;
  v_existing_payment      record;
  v_is_add_seats          boolean := false;
begin
  v_is_service_role := auth.role() = 'service_role';
  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other')
    then raise exception 'invalid payment method: %', p_method; end if;
  if p_reference is null or length(trim(p_reference)) = 0 then raise exception 'reference required'; end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status,
         q.domain, q.extension_months, q.is_add_seats, q.subtotal
    into v_quote
    from public.quotes q
   where q.id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  select p.id, p.receipt_voucher_no, p.customer_id
    into v_existing_payment
    from public.payments p
   where p.tenant_id = v_quote.tenant_id
     and p.quote_id  = p_quote_id
     and p.reference = p_reference
     and p.status    = 'received'
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_expected    := coalesce(v_quote.amount, 0);
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);
  v_domain               := v_quote.domain;
  v_extension_months     := coalesce(v_quote.extension_months, 12);
  v_is_add_seats         := coalesce(v_quote.is_add_seats, false);

  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;

  select coalesce(sum(amount), 0) into v_prior_received
    from public.payments where quote_id = p_quote_id and status = 'received';
  v_is_first_payment := (v_prior_received = 0);

  v_customer_id := v_quote.customer_id;
  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain, l.stage,
           l.state_code, l.state, l.gstin
      into v_lead from public.leads l
     where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if not found then raise exception 'lead % not found', v_quote.lead_id; end if;
    if v_domain is null then v_domain := v_lead.domain; end if;
    v_was_trial := (v_lead.stage = 'trial');

    insert into public.customers (tenant_id, name, contact_name, contact_email, contact_phone, domain, since, health, notes, state_code, state, gstin)
    values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, current_date,
            case when p_amount >= v_expected then 85 else 75 end, v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin)
    returning id into v_customer_id;

    update public.leads
       set stage              = 'won',
           trial_converted_at = case when v_was_trial then now() else trial_converted_at end
     where id = v_quote.lead_id and tenant_id = v_tenant_id;
    v_converted_now := true;
  elsif v_quote.lead_id is not null then
    select l.stage into v_lead from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if v_is_first_payment then
      update public.leads
         set trial_converted_at = case when stage = 'won' and trial_started_at is not null and trial_converted_at is null then now() else trial_converted_at end
       where id = v_quote.lead_id and tenant_id = v_tenant_id;
    end if;
  end if;

  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id);
  end if;

  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
      status, received_at, receipt_voucher_no, recorded_by)
    values (v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, auth.uid())
    returning id into v_payment_id;
  exception when unique_violation then
    select p.id, p.receipt_voucher_no, p.customer_id into v_existing_payment
      from public.payments p
     where p.tenant_id = v_tenant_id and p.quote_id = p_quote_id
       and p.reference = p_reference and p.status = 'received' limit 1;
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end;

  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial' end::public.payment_status;

  if v_is_first_payment and not v_is_renewal_quote and not v_is_add_seats then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    if v_first_line is not null then
      v_commitment := v_first_line->>'commitment';
      v_plan_name  := coalesce(v_first_line->>'name', 'Annual subscription');
      v_seats      := coalesce((v_first_line->>'qty')::int, 0);
      v_is_annual  := v_commitment is distinct from 'monthly' and v_commitment is not null;
      if v_is_annual and v_customer_id is not null then
        v_plan_lower := lower(v_plan_name);
        v_vendor := case
          when v_plan_lower like '%google%'    then 'google'::public.vendor
          when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
          when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
          when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
          when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
          else 'other'::public.vendor end;
        if v_domain is null and v_customer_id is not null then
          select domain into v_domain from public.customers where id = v_customer_id;
        end if;
        -- MRR = ex-GST monthly = annual taxable (subtotal) / 12 (bug #36)
        insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount, domain, quote_id)
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
          greatest(0, round(coalesce(v_quote.subtotal, v_expected) / 12.0))::int, current_date,
          (current_date + interval '1 year')::date, 'active', v_outstanding, v_domain, p_quote_id)
        returning id into v_new_sub_id;
        v_subscription_created := true;
        v_po_seats := v_seats; v_po_months := 12; v_po_plan := v_plan_name;
        v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
      end if;
    end if;
  elsif v_customer_id is not null and not v_is_renewal_quote and not v_is_add_seats then
    update public.subscriptions set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id and customer_id = v_customer_id and quote_id = p_quote_id and outstanding_amount > 0;
  end if;

  if v_is_renewal_quote and v_is_fully_paid then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    if v_first_line is not null then
      v_plan_name := coalesce(v_first_line->>'name', v_renewal_sub.plan);
      v_seats     := coalesce((v_first_line->>'qty')::int, v_renewal_sub.seats);
    else
      v_plan_name := v_renewal_sub.plan; v_seats := v_renewal_sub.seats;
    end if;
    -- MRR = ex-GST monthly = renewal taxable (subtotal) / term months (bug #36)
    v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric / greatest(v_extension_months, 1)))::int;
    update public.subscriptions
       set renewal_state = case when v_extension_months >= 12 then 'renewed' else renewal_state end,
           renewal_date  = (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date,
           seats = v_seats, plan = v_plan_name,
           mrr   = case when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = 0, renewal_quote_id = null,
           reminder_count = 0, last_reminder_sent_at_v2 = null, status = 'active'
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor; v_po_sub_id := v_renewal_sub.id;
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
      into v_unit_wholesale_pm from public.items
     where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
    if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
      v_unit_wholesale_pm := greatest(0, round(v_expected::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
    end if;
    v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
    v_po_id := public.next_document_number('purchase_order', v_tenant_id);
    insert into public.purchase_orders (
      id, tenant_id, subscription_id, customer_id, customer_name, domain,
      vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
    ) values (
      v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
      v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
      'Auto-created from quote ' || p_quote_id ||
      case when v_is_renewal_quote then ' (renewal/extension)' else ' (new sub)' end,
      auth.uid()
    );
    v_po_created := true;
  end if;

  update public.quotes
     set payment_status = v_new_payment_status,
         payment_amount = v_total_received,
         payment_method = p_method,
         payment_reference = p_reference,
         payment_received_at = now(),
         payment_notes = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id = v_customer_id,
         status = case
           when v_is_fully_paid and status in ('draft', 'sent', 'viewed') then 'accepted'::public.quote_status
           else status
         end
   where id = p_quote_id and tenant_id = v_tenant_id;

  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances into v_invoice
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_tenant_id;
    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((select sum((adv->>'amount')::int) from jsonb_array_elements(v_invoice.adjusted_advances) adv), 0);
      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due := coalesce(v_invoice.net_payable, v_invoice.amount);
      if v_post_invoice_received >= v_net_due then
        update public.invoices set status = 'paid', paid_date = current_date
         where id = v_quote.invoice_id and tenant_id = v_tenant_id;
        v_invoice_paid := true;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_voucher_no', v_receipt_voucher_no,
    'customer_id', v_customer_id,
    'total_received', v_total_received,
    'expected', v_expected,
    'outstanding', v_outstanding,
    'is_first_payment', v_is_first_payment,
    'is_fully_paid', v_is_fully_paid,
    'converted_now', v_converted_now,
    'subscription_created', v_subscription_created,
    'invoice_paid', v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice,
    'is_renewal_quote', v_is_renewal_quote,
    'renewal_rolled_forward', v_renewal_rolled_forward,
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'idempotent_replay', false
  );
end;
$function$;
