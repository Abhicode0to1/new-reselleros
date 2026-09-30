-- 20260929185929_day_book_salary_journal
--
-- WHAT THIS CHANGES
--   report_day_book() ab salary ke expense rows (category Salaries / Director's Remuneration)
--   ko voucher "Journal" dikhata hai, "Purchase" nahi. Salary ka bhugtan (paid expense) pehle ki
--   tarah "Payment" hi rehta hai. Baaki function 20260928120000 jaisa hi hai; grants waise hi.
--
-- WHY
--   Tally me salary ka kharcha Journal voucher se banta hai (Salary A/c Dr, Salary Payable Cr);
--   Purchase voucher sirf maal/sewa kharidne ke liye hai. Day Book CA ke paas jaati hai — salary
--   "Purchase" dikhe to wo use purchase register / GST input me gin sakta hai.
--
-- HOW TO VERIFY (alag run me)
--   select x->>'voucher', x->>'narration' from jsonb_array_elements(public.report_day_book(
--     date_trunc('month', current_date)::date, current_date)) x where x->>'narration' = 'Salaries';
--   → har row ka voucher = Journal. supabase/tests/trial_balance_daybook_msme.test.sql bhi.

begin;

create or replace function public.report_day_book(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Day Book nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Day Book ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Day Book ek baar me zyada se zyada 366 din ki banti hai (aapne % din chune). Chhota period chunein — mahina ya FY.', p_to - p_from + 1
      using errcode = 'invalid_parameter_value';
  end if;

  with v as (
    select i.invoice_date as d, 'Sales'::text as voucher, i.id as ref, i.customer_name as party,
           null::text as narr, i.amount::bigint as amt, 1 as ord
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status not in ('draft', 'void')
    union all
    select (p.received_at at time zone 'Asia/Kolkata')::date, 'Receipt',
           coalesce(p.receipt_voucher_no, p.id::text), c.name,
           nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
           p.amount::bigint, 2
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant
       and (p.received_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select (p.refunded_at at time zone 'Asia/Kolkata')::date, 'Refund',
           coalesce(p.refund_voucher_no, coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded'), c.name,
           p.refund_reason, p.amount::bigint, 3
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant and p.status = 'refunded' and p.refunded_at is not null
       and (p.refunded_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select pp.received_at, 'Receipt', coalesce(nullif(pp.reference, ''), pp.id::text), ps.customer_name,
           'Project: ' || ps.title, pp.amount::bigint, 2
      from public.project_payments pp
      join public.project_sales ps on ps.id = pp.project_id and ps.tenant_id = v_tenant
     where pp.tenant_id = v_tenant and pp.received_at between p_from and p_to
    union all
    select cn.credit_date, 'Credit Note', cn.id, cn.customer_name,
           coalesce(cn.reason, 'against ' || cn.invoice_id), cn.amount::bigint, 4
      from public.credit_notes cn
     where cn.tenant_id = v_tenant and cn.credit_date between p_from and p_to
    union all
    select dn.debit_date, 'Debit Note', dn.id, dn.customer_name,
           coalesce(dn.reason, 'against ' || dn.invoice_id), dn.amount::bigint, 4
      from public.debit_notes dn
     where dn.tenant_id = v_tenant and dn.debit_date between p_from and p_to
    union all
    -- Salary ka kharcha Journal hai (Tally: Salary A/c Dr / Salary Payable A/c Cr), Purchase nahi —
    -- CA ko Day Book me salary kharidari jaisi dikhe to wo galat ledger me jaati hai. Categories
    -- wahi jo app salary maanta hai: lib/accounting/project-cost.ts SALARY_CATEGORIES.
    select e.expense_date,
           case when e.category in ('Salaries', 'Director''s Remuneration') then 'Journal' else 'Purchase' end,
           coalesce(e.bill_no, e.id), e.vendor_name, e.category, e.amount::bigint, 5
      from public.expenses e
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
    union all
    select vb.bill_date, 'Purchase', coalesce(vb.bill_no, vb.id), vb.vendor_name, vb.category, vb.total::bigint, 5
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
    union all
    select e.paid_date, 'Payment', coalesce(e.bill_no, e.id) || ' · paid', e.vendor_name,
           e.payment_method, e.amount::bigint, 6
      from public.expenses e
     where e.tenant_id = v_tenant and e.paid and e.paid_date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(v.d, 'YYYY-MM-DD'), 'voucher', v.voucher, 'reference', v.ref,
           'party', v.party, 'narration', v.narr, 'amount', v.amt)
         order by v.d, v.ord, v.ref), '[]'::jsonb)
    into v_out
    from v;
  return v_out;
end;
$function$;

commit;
