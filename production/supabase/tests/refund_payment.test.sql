-- Regression test: refund_payment (migration 20260901120000, audit A5b)
--
-- Kya saabit hota hai (self-asserting, sab rollback):
--   1. Refund ke baad: status 'refunded' + RFV voucher + wajah darj.
--   2. Quote wapas 'none'/sahi status par + payment_amount recomputed.
--   3. Usi payment ki 'open' overpayment-credit band ('refunded').
--   4. Dobara refund → saaf error (voucher naam ke saath).
--   5. GST-invoice wale quote par refund REFUSE + message me agla kadam.
--   6. Chhoti/khaali wajah refuse hoti hai.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('eeeeeeee-0000-0000-0000-0000000000e1'::uuid, 'REFUND TEST CO', 'refund@example.in', '07');

insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values
  ('Q-REF-MAIN', 'eeeeeeee-0000-0000-0000-0000000000e1'::uuid, 'Refund Cust', 10000, 8475, 18, 'sent', 'awaiting', '[]'::jsonb),
  ('Q-REF-INV',  'eeeeeeee-0000-0000-0000-0000000000e1'::uuid, 'Invoiced Cust', 5000, 4237, 18, 'sent', 'awaiting', '[]'::jsonb);

do $$
declare
  rp   jsonb;
  rr   jsonb;
  v    record;
  n    integer;
  msg  text;
begin
  -- Overpaid bhugtan: 12,000 on a 10,000 quote → 2,000 ki open credit banti hai.
  rp := public.record_payment('Q-REF-MAIN', 12000, 'bank_transfer', 'ref-pay-1', null);

  -- ── 6. Khaali wajah refuse ───────────────────────────────────────────────
  begin
    rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, '  ');
    raise exception 'FAIL 6: blank reason accepted';
  exception when invalid_parameter_value then null;
  end;

  -- ── 1+2+3. Asli refund ───────────────────────────────────────────────────
  rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, 'Customer ne order cancel kiya');

  if rr->>'refund_voucher_no' is null or (rr->>'refund_voucher_no') !~ '^RFV-' then
    raise exception 'FAIL 1a: RFV voucher missing/odd (%)', rr->>'refund_voucher_no';
  end if;

  select status, refund_reason, refund_voucher_no into v
    from public.payments where id = nullif(rp->>'payment_id','')::uuid;
  if v.status <> 'refunded' or v.refund_reason is null or v.refund_voucher_no is null then
    raise exception 'FAIL 1b: payment row not fully stamped (status=% reason=% rfv=%)', v.status, v.refund_reason, v.refund_voucher_no;
  end if;

  select payment_status, payment_amount into v from public.quotes where id = 'Q-REF-MAIN';
  if v.payment_status <> 'none' or coalesce(v.payment_amount, 0) <> 0 then
    raise exception 'FAIL 2: quote not recomputed (status=% amount=%)', v.payment_status, v.payment_amount;
  end if;

  select count(*) into n from public.customer_credits
   where source_payment_id = nullif(rp->>'payment_id','')::uuid and status = 'open';
  if n <> 0 then
    raise exception 'FAIL 3: overpayment credit still OPEN after refund — free money floating';
  end if;
  if coalesce((rr->>'credits_closed')::int, 0) <> 1 then
    raise exception 'FAIL 3b: credits_closed should be 1, got %', rr->>'credits_closed';
  end if;

  -- ── 4. Dobara refund → error ─────────────────────────────────────────────
  begin
    rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, 'dobara koshish');
    raise exception 'FAIL 4: double refund allowed';
  exception when invalid_parameter_value then
    get stacked diagnostics msg = message_text;
    if position('RFV-' in msg) = 0 then
      raise exception 'FAIL 4b: double-refund error does not name the voucher (%)', msg;
    end if;
  end;

  -- ── 5. GST-invoice wala quote → refuse, agla kadam message me ────────────
  rp := public.record_payment('Q-REF-INV', 5000, 'upi', 'ref-pay-2', null);
  insert into public.invoices (id, tenant_id, customer_name, amount, status, invoice_date, due_date)
    values ('INV-FAKE-1', 'eeeeeeee-0000-0000-0000-0000000000e1'::uuid, 'Invoiced Cust', 5000, 'paid', current_date, current_date);
  update public.quotes set invoice_id = 'INV-FAKE-1' where id = 'Q-REF-INV';
  begin
    rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, 'invoice wale par koshish');
    raise exception 'FAIL 5: refund allowed against an issued GST invoice';
  exception when invalid_parameter_value then
    get stacked diagnostics msg = message_text;
    if position('CREDIT NOTE' in upper(msg)) = 0 then
      raise exception 'FAIL 5b: refusal without the next step (%)', msg;
    end if;
  end;

  raise notice 'PASS: refund_payment — RFV, recompute, credit-close, double-guard, invoice-guard';
end $$;

rollback;
