-- refund_payment — paisa wapas karne ka PEHLA sahi raasta (audit A5b, 1 Sep 2026).
--
-- Ab tak refund ka koi raasta tha hi nahi: `useRefundPayment` sirf status
-- palat-ta tha — na quote ka payment_status, na subscription ka outstanding,
-- na RFV voucher, na overpayment-credit ka band hona. Zero callers the, aur
-- yahi uski ek-matra suraksha thi. CLAUDE.md §17b isi ko "TBD" keh kar
-- 3 mahine se taal raha tha.
--
-- Ye function EK transaction me:
--   1. payment ko 'refunded' karta hai + wajah + RFV voucher number
--      (Refund Voucher — CGST 31(3)(e); series pehle din se bani thi,
--      allocate KABHI nahi hui thi).
--   2. Usi payment se bani 'open' overpayment-credit band karta hai —
--      warna refund ke baad bhi customer ke paas kharch karne layak credit
--      tairti rehti.
--   3. Quote ka payment_status/amount bache hue 'received' se dobara ginta
--      hai (wahi ganit jo delete_payment ka hai).
--   4. Subscription ka outstanding_amount wapas khol deta hai.
--
-- JO YE NAHI KARTA, JAAN-BOOJH KAR:
--   - Gateway par paisa NAHI bhejta (Razorpay refund API wired nahi hai) —
--     return me saaf likha aata hai; asli paisa operator gateway/bank se
--     bhejta hai, ye kitab-side hai.
--   - GST tax-invoice wale quote par REFUSE karta hai — wahan pehle credit
--     note banta hai (CGST §34; flow app me pehle se hai), warna GSTR ka
--     milaan tootta hai. §24: message me agla kadam likha hai.
--   - MRR/seats NAHI chhoota — refund cancellation nahi hai; add-seats
--     wale par delete_payment jaisa hi guard.

alter table public.payments
  add column if not exists refund_voucher_no text;

comment on column public.payments.refund_voucher_no is
  'RFV series (CGST 31(3)(e)) — refund_payment allocate karta hai; null = kabhi refund nahi hua.';

create or replace function public.refund_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
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
  if v_tenant is not null and v_pay.tenant_id is distinct from v_tenant then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
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
end $$;

revoke all on function public.refund_payment(uuid, text) from public;
grant execute on function public.refund_payment(uuid, text) to authenticated;
