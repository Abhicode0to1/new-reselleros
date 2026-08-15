-- ============================================================
-- ResellerOS — record_payment: allow service-role callers
-- Migration: 0012_record_payment_service_role.sql
-- ============================================================
-- Why
--   Razorpay webhooks, public buy-page checkout, and cron jobs all run
--   under the service_role key — they have no auth.uid() and therefore
--   no current_tenant_id() lookup. The original 0006 migration raised
--   "No tenant context" for these callers, blocking real payments from
--   ever being recorded automatically.
--
-- What
--   This migration re-creates record_payment with a role-aware authorization:
--     - service_role  : derive tenant from the quote itself (service role
--                       bypasses RLS anyway; cross-tenant guard is moot).
--     - authenticated : keep the existing current_tenant_id() requirement
--                       and the cross-tenant guard.
--
-- Compatibility
--   Function signature unchanged (5 args). All existing callers continue
--   to work. The change is purely inside the function body.
-- ============================================================

begin;

create or replace function public.record_payment(
  p_quote_id   text,
  p_amount     integer,
  p_method     text,
  p_reference  text,
  p_notes      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  v_subscription_created  boolean := false;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;

  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
begin
  -- ── 0. Caller authorization ────────────────────────────────────────
  -- Two modes:
  --   (a) Authenticated user — require current_tenant_id() and enforce
  --       cross-tenant guard against the quote.
  --   (b) Service role (Razorpay webhook, public buy flow, cron) — no
  --       auth.uid(); derive tenant from the quote itself. Service role
  --       already bypasses RLS so there is no "other tenant" to leak to.
  v_is_service_role := auth.role() = 'service_role';

  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context — record_payment requires an authenticated session or service role';
    end if;
  end if;

  -- ── 1. Validate inputs ────────────────────────────────────────────
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be > 0 (got %)', p_amount;
  end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other') then
    raise exception 'invalid payment method: %', p_method;
  end if;
  if p_reference is null or length(trim(p_reference)) = 0 then
    raise exception 'reference is required';
  end if;

  -- ── 2. Lock + read quote ──────────────────────────────────────────
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
     for update;

  if not found then
    raise exception 'quote % not found', p_quote_id;
  end if;

  -- Cross-tenant guard — only enforced for authenticated callers. Service
  -- role calls trust the quote's tenant_id directly.
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);

  -- ── 3. Sum prior received payments ────────────────────────────────
  select coalesce(sum(amount), 0)
    into v_prior_received
    from public.payments
   where quote_id = p_quote_id
     and status = 'received';

  v_is_first_payment := (v_prior_received = 0);

  -- ── 4. Lead → customer conversion ─────────────────────────────────
  v_customer_id := v_quote.customer_id;

  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes
      into v_lead
      from public.leads l
     where l.id = v_quote.lead_id
       and l.tenant_id = v_tenant_id;

    if not found then
      raise exception 'lead % referenced by quote % not found in tenant', v_quote.lead_id, p_quote_id;
    end if;

    insert into public.customers (
      tenant_id, name, contact_name, contact_email, contact_phone,
      since, health, notes
    ) values (
      v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email,
      v_lead.contact_phone, current_date,
      case when p_amount >= v_expected then 85 else 75 end,
      v_lead.notes
    )
    returning id into v_customer_id;

    update public.leads
       set stage = 'won'
     where id = v_quote.lead_id
       and tenant_id = v_tenant_id;

    v_converted_now := true;
  end if;

  -- ── 5. Receipt voucher (only if no invoice yet) ───────────────────
  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id);
  end if;

  -- ── 6. Insert payment row ────────────────────────────────────────
  -- recorded_by is nullable; service-role calls produce NULL which is fine.
  insert into public.payments (
    tenant_id, quote_id, customer_id, amount, method, reference, notes,
    status, received_at, receipt_voucher_no, recorded_by
  ) values (
    v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
    nullif(trim(coalesce(p_notes, '')), ''),
    'received', now(), v_receipt_voucher_no, auth.uid()
  )
  returning id into v_payment_id;

  -- ── 7. Recompute totals ──────────────────────────────────────────
  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;

  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial'
  end::public.payment_status;

  -- ── 8. Subscription handling ──────────────────────────────────────
  if v_is_first_payment then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0
      else null
    end;

    if v_first_line is not null then
      v_commitment := v_first_line->>'commitment';
      v_plan_name  := coalesce(v_first_line->>'name', 'Annual subscription');
      v_seats      := coalesce((v_first_line->>'qty')::int, 0);

      v_is_annual := v_commitment is distinct from 'monthly' and v_commitment is not null;

      if v_is_annual and v_customer_id is not null then
        v_plan_lower := lower(v_plan_name);
        v_vendor := case
          when v_plan_lower like '%google%'      then 'google'::public.vendor
          when v_plan_lower like '%m365%'        then 'microsoft'::public.vendor
          when v_plan_lower like '%microsoft%'   then 'microsoft'::public.vendor
          when v_plan_lower like '%365%'         then 'microsoft'::public.vendor
          when v_plan_lower like '%zoho%'        then 'zoho'::public.vendor
          else 'other'::public.vendor
        end;

        insert into public.subscriptions (
          tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
          start_date, renewal_date, status, outstanding_amount
        ) values (
          v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name,
          v_vendor, v_seats,
          greatest(0, round(v_expected / 12.0))::int,
          current_date,
          (current_date + interval '1 year')::date,
          'active',
          v_outstanding
        );

        v_subscription_created := true;
      end if;
    end if;

  elsif v_customer_id is not null then
    update public.subscriptions
       set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id
       and customer_id = v_customer_id
       and outstanding_amount > 0;
  end if;

  -- ── 9. Update the quote ───────────────────────────────────────────
  update public.quotes
     set payment_status      = v_new_payment_status,
         payment_amount      = v_total_received,
         payment_method      = p_method,
         payment_reference   = p_reference,
         payment_received_at = now(),
         payment_notes       = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id         = v_customer_id
   where id = p_quote_id
     and tenant_id = v_tenant_id;

  -- ── 10. Invoice auto-paid check ───────────────────────────────────
  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances
      into v_invoice
      from public.invoices i
     where i.id = v_quote.invoice_id
       and i.tenant_id = v_tenant_id;

    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((
        select sum((adv->>'amount')::int)
          from jsonb_array_elements(v_invoice.adjusted_advances) adv
      ), 0);

      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due               := coalesce(v_invoice.net_payable, v_invoice.amount);

      if v_post_invoice_received >= v_net_due then
        update public.invoices
           set status    = 'paid',
               paid_date = current_date
         where id = v_quote.invoice_id
           and tenant_id = v_tenant_id;

        v_invoice_paid := true;
      end if;
    end if;
  end if;

  -- ── 11. Return ───────────────────────────────────────────────────
  return jsonb_build_object(
    'payment_id',           v_payment_id,
    'receipt_voucher_no',   v_receipt_voucher_no,
    'customer_id',          v_customer_id,
    'total_received',       v_total_received,
    'expected',             v_expected,
    'outstanding',          v_outstanding,
    'is_first_payment',     v_is_first_payment,
    'is_fully_paid',        v_is_fully_paid,
    'converted_now',        v_converted_now,
    'subscription_created', v_subscription_created,
    'invoice_paid',         v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice
  );
end;
$$;

grant execute on function public.record_payment(text, integer, text, text, text) to authenticated;

commit;
