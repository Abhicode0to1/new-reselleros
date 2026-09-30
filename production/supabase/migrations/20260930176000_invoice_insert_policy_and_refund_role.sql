-- 20260930176000_invoice_insert_policy_and_refund_role.sql
--
-- R-042 (Pardeep, 30 Sep 2026). Two guards that asked only "which workspace?".
--
-- ══ 1. ANY MEMBER COULD INSERT AN INVOICE ════════════════════════════════════
--
--   invoices_insert  FOR INSERT  WITH CHECK (tenant_id = current_tenant_id())
--
-- That is the whole rule. A logged-in sales or support account could POST straight to
-- /rest/v1/invoices with ANY id and ANY invoice_date — which walks around
-- next_document_number entirely. The number is the thing CGST Rule 46 requires to be an
-- unbroken series per tenant per financial year, and this let anybody write outside it:
-- a duplicate number, a number from a closed year, a number the series never issued.
--
-- Nothing legitimate uses it. Checked before dropping:
--   * no browser code inserts into invoices (grep: zero `from("invoices")…insert`);
--   * every writer is a SECURITY DEFINER function — generate_invoice,
--     raise_project_milestone_invoice, raise_subscription_billing, create_direct_invoice;
--   * those run as `postgres`, which OWNS public.invoices, and the table is not
--     FORCE ROW LEVEL SECURITY (relforcerowsecurity = false), so the owner bypasses RLS
--     and they keep working with no INSERT policy at all. Measured, not assumed.
--
-- So an invoice can now be created by the numbering path and by nothing else.
--
-- ══ 2. A REFUND HAD NO ROLE CHECK ════════════════════════════════════════════
--
-- refund_payment checked the tenant (hardened by R-013) and never asked WHO. A refund
-- consumes a Refund Voucher number from the gapless CGST 31(3)(e) series, recomputes the
-- quote and subscription, and closes customer credit. Being in the workspace is not
-- authority to do that.
--
-- owner / manager / accountant, via the same current_user_has_role() S41 introduced, so
-- there is one definition of "who may touch money" rather than a role list copied about.
--
-- The body below is the LIVE definition from pg_get_functiondef (AGENTS.md L8/L9) with
-- only that block added.

begin;

-- ── 1 ───────────────────────────────────────────────────────────────────────────────
drop policy if exists invoices_insert on public.invoices;

-- ── 2 ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_pay        record;
  v_quote      record;
  v_remaining  integer;
  v_expected   integer;
  v_new_status public.payment_status;
  v_rfv        text;
  v_bank_cnt   integer;
  v_credits    integer := 0;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_pay.tenant_id is distinct from v_tenant) then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  /* ── R-042 (Pardeep, 30 Sep 2026): tenant was the only question being asked ──────
     Being in the right workspace is not authority to send money back. A sales or support
     login could refund any payment in the workspace — and a refund is not reversible
     bookkeeping: it consumes a Refund Voucher number from the gapless CGST 31(3)(e)
     series, recomputes the quote and the subscription, and closes customer credit.

     owner / manager / accountant, the same three S41 uses for money writes, through the
     same helper — so "who may touch money" has one definition instead of a role list
     copied into each guard.

     A session with NO JWT (psql, a migration, the SQL tests) is deliberately left alone,
     exactly as the tenant check above leaves it alone: it is not a PostgREST caller. */
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception
      'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series and reopens the balance on that customer, so it is not a staff-level action. Ask one of them to record it (Payments → the payment → Refund).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_pay.status = 'refunded' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = 'invalid_parameter_value';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, customer_id, customer_name
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'Is quote par GST invoice jaari hai — pehle us invoice ka CREDIT NOTE banaiye (invoice ke page se), phir refund book kariye. Tax-invoice ke against seedha refund GSTR ka milaan tod deta hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then refund.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'Ye add-seats ki payment hai — pehle subscription par seats ghataiye, phir refund; warna seats mile hue aur paisa wapas dono ho jate.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_rfv := public.next_document_number('refund_voucher', v_pay.tenant_id);

  update public.payments
     set status = 'refunded',
         refunded_at = now(),
         refund_reason = trim(p_reason),
         refund_voucher_no = v_rfv
   where id = p_payment_id;

  /* Isi payment ki tairti overpayment-credit band — paisa wapas ja raha hai,
     credit ke roop me dobara kharch nahi ho sakta. */
  update public.customer_credits
     set status = 'refunded'
   where source_payment_id = p_payment_id and status = 'open';
  get diagnostics v_credits = row_count;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);
  v_new_status := case
    when v_remaining <= 0          then 'none'
    when v_remaining >= v_expected then 'received'
    else                                'partial' end::public.payment_status;

  update public.quotes
     set payment_status = v_new_status,
         payment_amount = v_remaining
   where id = v_pay.quote_id;

  update public.subscriptions
     set outstanding_amount = greatest(0, v_expected - v_remaining)
   where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;

  return jsonb_build_object(
    'refund_voucher_no', v_rfv,
    'payment_id', p_payment_id,
    'amount', v_pay.amount,
    'quote_id', v_pay.quote_id,
    'new_payment_status', v_new_status,
    'credits_closed', v_credits,
    'gateway_refunded', false
  );
end $function$;

commit;
