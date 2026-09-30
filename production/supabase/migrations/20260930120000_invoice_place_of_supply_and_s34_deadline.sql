-- 20260930120000_invoice_place_of_supply_and_s34_deadline.sql
--
-- R-041 (Pardeep, 30 Sep 2026). Two GST correctness holes in the issuing path.
--
-- ══ 1. AN UNKNOWN PLACE OF SUPPLY WAS BILLED AS CGST+SGST ════════════════════
--
--   v_inter := (v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st);
--
-- A NULL state on either side makes that FALSE, and FALSE means intra-state, which means
-- CGST+SGST. So "we do not know where this supply happened" was silently answered with a
-- confident tax head — AGENTS.md §2, on a statutory document.
--
-- It fails in the expensive direction. An inter-state supply billed as CGST+SGST pays the
-- wrong government: GSTR-1 will not reconcile it, the customer cannot take the credit, and
-- fixing it afterwards means a credit note and a fresh invoice. On this tenant 23 of 35
-- customers have no state_code at all.
--
-- EXPORT is the case where having no Indian state is CORRECT rather than missing, so it is
-- separated rather than swept into the refusal: a recipient outside India has no Indian
-- place of supply and the supply is zero-rated (IGST s16). Those quotes already carry
-- tax_rate 0 from the app's own isExportSupply, so there is no split to get wrong.
--
-- Everything else now REFUSES, and the message names the screen that fixes it (§24). A
-- refused invoice is recoverable in thirty seconds; a wrong tax head is not.
--
-- ══ 2. A CREDIT NOTE HAD NO DEADLINE ═════════════════════════════════════════
--
-- CGST Section 34(2): a credit note may be declared up to 30 November following the end of
-- the financial year of the supply (or the annual return filing date, whichever is
-- earlier). Nothing checked it, so a note raised years later looked ordinary and quietly
-- wrote off GST that can no longer be reduced.
--
-- Only the 30 November limb is enforced — the annual-return date is not in this database.
-- That makes this the PERMISSIVE side of the rule, said out loud rather than claimed as
-- complete.
--
-- Bodies below are the LIVE definitions from pg_get_functiondef (AGENTS.md L8/L9), with
-- only these changes applied. The IST dates in them came from R-015 and are unchanged.

begin;

-- ── generate_invoice ──
CREATE OR REPLACE FUNCTION public.generate_invoice(p_quote_id text)
 RETURNS TABLE(invoice_id text, net_payable integer, total_advances integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := public.ist_today();
  v_taxable   integer;
  v_tax       integer;
  v_rate      integer;
  v_cust_st   text;
  v_sell_st   text;
  v_cust_country text;
  v_is_export boolean;
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

  select c.state_code, c.country into v_cust_st, v_cust_country
    from public.customers c where c.id = v_quote.customer_id;
  select t.state_code into v_sell_st from public.tenants t where t.id = v_quote.tenant_id;

  /* ── R-041 (Pardeep, 30 Sep 2026): an unknown place of supply used to mean CGST+SGST ──
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state_code on either side resolved to FALSE = intra-state = CGST+SGST. That
     is a missing fact turned into a confident tax head (AGENTS.md §2), and it is the
     expensive direction: an inter-state supply billed as CGST+SGST is tax paid to the wrong
     government, which GSTR-1 will not reconcile and which the customer cannot claim.
     23 of this tenant's customers have no state_code.

     EXPORT is the one case where no state is correct rather than missing: a recipient
     outside India has no Indian place of supply, and the supply is zero-rated under IGST
     Section 16 (LUT or with payment of tax). Those quotes already carry tax_rate 0, set by
     the same `isExportSupply` the app uses, so there is no split to get wrong.

     Everything else stops. §24: the message names the screen that fixes it. */
  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply; the zero rate on the quote governs
  elsif v_cust_st is null or btrim(v_cust_st) = '' then
    raise exception
      'Cannot issue this invoice: % has no state on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit), then issue the invoice.',
      v_quote.customer_name, v_quote.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null or btrim(v_sell_st) = '' then
    raise exception
      'Cannot issue this invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company, then issue the invoice.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);
  end if;

  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  v_id := public.next_document_number('invoice', v_quote.tenant_id, public.ist_today());
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
    -- THE ONE CHANGE: the fallback was 0, which made every termless invoice due on issue.
    v_today, v_today + coalesce(v_quote.payment_terms_days, 30), case when v_status = 'paid' then v_today else null end,
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

-- ── issue_credit_note ──
CREATE OR REPLACE FUNCTION public.issue_credit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_supply_fy_end   text;
  v_s34_deadline    date;
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

  /* R-041 added i.invoice_date: the Section 34(2) deadline is measured from the FY of the
     SUPPLY, so the check below needs the invoice date rather than today. */
  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state, i.invoice_date
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  select coalesce(sum(amount), 0) into v_already from public.credit_notes where invoice_id = p_invoice_id;
  v_max_creditable := coalesce(v_inv.amount, 0) - v_already;
  if p_gross_amount > v_max_creditable then
    raise exception 'Credit % exceeds the creditable balance % on invoice %',
      p_gross_amount, v_max_creditable, p_invoice_id using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  /* ── R-041: CGST Section 34(2) — a credit note has a deadline ──────────────────
     A credit note may be declared up to 30 NOVEMBER following the end of the financial
     year of the original supply (or the date the annual return is filed, whichever is
     earlier). Past that, the supplier cannot reduce its output tax liability: the note
     can still be raised commercially, but the GST on it is simply lost, and GSTR-1 will
     not accept it against that invoice.

     Nothing checked this. A note raised in, say, January against an invoice from two
     financial years earlier looked completely normal and quietly wrote off the tax.

     The annual-return half is not knowable from this database, so only the 30 November
     limb is enforced — the earlier of the two is what the law asks for, so this is the
     permissive side of the rule and is stated as such rather than claimed as complete. */
  v_supply_fy_end := (public.indian_fiscal_year(coalesce(v_inv.invoice_date, public.ist_today())));
  v_s34_deadline  := make_date(2000 + substring(v_supply_fy_end from 5 for 2)::int, 11, 30);
  if public.ist_today() > v_s34_deadline then
    raise exception
      'Too late for a credit note against invoice %: it was supplied in FY %, and CGST Section 34(2) allows one only up to 30 November %. Raise a refund or a commercial adjustment instead — a credit note now cannot reduce the GST you already paid.',
      p_invoice_id, v_supply_fy_end, to_char(v_s34_deadline, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  v_cn_id := public.next_document_number('credit_note', v_inv.tenant_id, public.ist_today());
  if v_cn_id is null then raise exception 'Could not allocate a credit note number'; end if;

  insert into public.credit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, credit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_cn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

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

commit;
