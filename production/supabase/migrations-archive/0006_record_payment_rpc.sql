-- ============================================================
-- ResellerOS — atomic record_payment RPC
-- Migration: 0006_record_payment_rpc.sql
-- ============================================================
-- Purpose
--   Today's record-payment-dialog.tsx chains 7-9 sequential client-side
--   mutations to record a single payment (issue RV → insert payment →
--   compute totals → create customer → promote lead → create subscription
--   → update quote → update invoice). If the network drops mid-chain
--   (e.g. between customer insert and quote update), the tenant is left
--   in an inconsistent state — orphan payments, stuck-in-prospect quotes,
--   double-converted leads on retry.
--
--   This migration introduces ONE Postgres SECURITY DEFINER function that
--   performs the whole flow atomically — either every write commits, or
--   nothing does. Row-level locking via SELECT … FOR UPDATE on the source
--   quote also prevents two concurrent calls from double-creating a
--   customer or subscription for the same prospect quote.
--
-- CLAUDE.md §17b lists `record_payment` as TBD with status "client-side
-- mutations are tolerated but flagged as tech debt" — this migration
-- closes that gap.
--
-- API
--   select * from public.record_payment(
--     p_quote_id  := 'Q-2025-26-0042',
--     p_amount    := 50000,
--     p_method    := 'upi',
--     p_reference := 'UPI/123456789',
--     p_notes     := 'Half payment, balance in 30 days'
--   );
--
-- Returns a single jsonb row matching the shape consumed by the
-- record-payment-dialog onSuccess handler:
--   {
--     "payment_id":           uuid,
--     "receipt_voucher_no":   text|null,
--     "customer_id":          uuid|null,
--     "total_received":       int,
--     "expected":             int,
--     "outstanding":          int,
--     "is_first_payment":     bool,
--     "is_fully_paid":        bool,
--     "converted_now":        bool,
--     "subscription_created": bool,
--     "invoice_paid":         bool,
--     "has_existing_invoice": bool
--   }
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
  -- Quote snapshot (locked for this transaction)
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;

  -- Receipt voucher (only issued when no invoice exists yet)
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;

  -- Payment row
  v_payment_id            uuid;

  -- Totals
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;

  -- Lead → customer conversion
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;

  -- Subscription auto-create (only on annual commitments, first payment)
  v_subscription_created  boolean := false;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;

  -- Invoice auto-paid check
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
begin
  -- ── 0. Caller authorization ────────────────────────────────────────
  v_caller_tenant := public.current_tenant_id();
  if v_caller_tenant is null then
    raise exception 'No tenant context — record_payment requires an authenticated session';
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
  -- FOR UPDATE prevents two concurrent record_payment calls on the same
  -- quote from double-creating customer or subscription rows.
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
     for update;

  if not found then
    raise exception 'quote % not found', p_quote_id;
  end if;

  -- Cross-tenant guard — the RLS-bypassing SECURITY DEFINER could otherwise
  -- be abused if quote_id is leaked across tenants.
  if v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);

  -- ── 3. Sum prior received payments (drives isFirstPayment + totals) ──
  -- Payments table enforces amount > 0, so sum = 0 ⇔ no prior receipts.
  select coalesce(sum(amount), 0)
    into v_prior_received
    from public.payments
   where quote_id = p_quote_id
     and status = 'received';

  v_is_first_payment := (v_prior_received = 0);

  -- ── 4. Lead → customer conversion (first payment on a prospect) ───
  -- Per Indian SaaS reseller reality, service starts at advance receipt,
  -- not full payment. Outstanding lives on the subscription.
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

    -- Health 85 if fully paid this call, else 75 (some risk)
    -- We don't know "fully paid" yet because we haven't inserted this
    -- payment — but it's just an initial signal, so use a conservative
    -- 75 here and let downstream signals adjust over time.
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

    -- Promote the lead
    update public.leads
       set stage = 'won'
     where id = v_quote.lead_id
       and tenant_id = v_tenant_id;

    v_converted_now := true;
  end if;

  -- ── 5. Issue Receipt Voucher (only if no invoice yet) ─────────────
  -- CGST Section 31(3)(d) — RV is for advance payments BEFORE invoice
  -- only. Post-invoice payments belong to the invoice chain.
  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id);
  end if;

  -- ── 6. Insert payment row ────────────────────────────────────────
  insert into public.payments (
    tenant_id, quote_id, customer_id, amount, method, reference, notes,
    status, received_at, receipt_voucher_no, recorded_by
  ) values (
    v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
    nullif(trim(coalesce(p_notes, '')), ''),
    'received', now(), v_receipt_voucher_no, auth.uid()
  )
  returning id into v_payment_id;

  -- ── 7. Recompute totals after insert ──────────────────────────────
  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;

  -- Quote payment_status:
  --   - Preserve 'invoiced' terminal state (invoice already issued)
  --   - Else 'received' when balance is zero
  --   - Else 'partial' (some payment, balance remains)
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial'
  end::public.payment_status;

  -- ── 8. Subscription handling ──────────────────────────────────────
  -- 8a. First payment + annual commitment → spawn subscription
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

      -- "monthly" is flex; everything else is a 1-year commitment
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

  -- 8b. Subsequent payment on existing customer → update outstanding
  --     on their active subscriptions. (Best-effort: schema lacks
  --     subscription.quote_id FK so we can't perfectly attribute.
  --     Flagged as future tech debt — needs schema change to fix
  --     properly for multi-quote customers.)
  elsif v_customer_id is not null then
    update public.subscriptions
       set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id
       and customer_id = v_customer_id
       and outstanding_amount > 0;
  end if;

  -- ── 9. Update the quote (running totals + new status) ─────────────
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
  -- If an invoice exists and net payable (after frozen advances) is now
  -- covered by post-invoice payments, mark it paid. Adjusted advances
  -- are FROZEN at invoice issue time per CGST Rule 53 — we subtract
  -- their sum to figure out what's been received since the invoice.
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

  -- ── 11. Return the consolidated result for the client ─────────────
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

comment on function public.record_payment(text, integer, text, text, text) is
  'Atomically records a payment against a quote: issues RV (if pre-invoice), inserts payment ledger row, converts prospect→customer on first payment, promotes lead, creates annual subscription, updates outstanding, and marks invoice paid when net_payable is covered. Single transaction — all or nothing.';

grant execute on function public.record_payment(text, integer, text, text, text) to authenticated;

commit;

-- ============================================================
-- Smoke tests (run manually post-apply):
--
-- 1. Happy path — first payment on prospect quote, full amount
--    select public.record_payment(
--      'Q-2025-26-0001', 60000, 'upi', 'UPI/TEST/1', 'Smoke test'
--    );
--    → expect: converted_now=true, subscription_created=true,
--              is_fully_paid=true, outstanding=0
--
-- 2. Partial payment then balance — same quote
--    select public.record_payment('Q-XYZ', 30000, 'upi', 'p1');
--    → is_first_payment=true, is_fully_paid=false, outstanding=30000
--    select public.record_payment('Q-XYZ', 30000, 'upi', 'p2');
--    → is_first_payment=false, is_fully_paid=true, outstanding=0
--
-- 3. Cross-tenant attack — should raise:
--    set local "request.jwt.claim.sub" = '<OTHER TENANT USER>';
--    select public.record_payment('Q-MY-QUOTE', 100, 'upi', 'x');
--    → exception: 'quote does not belong to your tenant'
--
-- 4. Idempotency note — calling twice with same reference will currently
--    create TWO payment rows. Future hardening: add a unique
--    (quote_id, reference) constraint when status='received', or a
--    client-supplied idempotency_key argument. Not required for v1
--    because UI guards via mutation pending state.
-- ============================================================
