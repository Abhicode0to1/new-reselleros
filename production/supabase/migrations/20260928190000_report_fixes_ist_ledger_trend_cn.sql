-- S39 (28 Sep 2026): do galtiyan jo S17 ne parity ke liye jaan-boojh kar rakhi thi.
--
-- 1. Ledger: payment / refund ki tareekh ab received_at / refunded_at ka IST din hai, UTC nahi.
--    Pehle 00:00–05:30 IST ke beech aaya paisa pichhle din dikhta tha (AGENTS.md §6 IST trap) —
--    customer ka khata aur bank statement alag din dikhate the.
-- 2. P&L trend: credit notes ab mahine ka revenue ghatate hain (debit notes badhate hain), jaise
--    headline P&L karta hai. Pehle chart aur upar ka number credit-note wale mahine mein alag the.
--
-- Sirf yahi do function; signature, grants aur baaki niyam 20260928110000 jaise hi
-- (create or replace grants nahi chhedta).

create or replace function public.report_pnl_monthly(p_from date, p_to date)
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
    raise exception 'P&L trend nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'revenue', m.revenue, 'expenses', m.expenses)
                            order by m.month), '[]'::jsonb)
    into v_out
    from (
      select k.month, sum(k.rev)::bigint as revenue, sum(k.exp)::bigint as expenses
        from (
          select to_char(i.invoice_date, 'YYYY-MM') as month,
                 coalesce(i.taxable_value::bigint,
                   floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as rev,
                 0::bigint as exp
            from public.invoices i
           where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
             and i.status in ('pending', 'paid', 'overdue')
          union all
          select to_char(e.expense_date, 'YYYY-MM'), 0, e.amount::bigint
            from public.expenses e
           where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
          union all
          -- S39: credit note us mahine ka revenue ghataata hai, debit note badhata hai —
          -- headline report_pnl jaisa (taxable value), taaki trend aur headline ek hi number dein.
          select to_char(c.credit_date, 'YYYY-MM'), -coalesce(c.taxable_value, 0)::bigint, 0
            from public.credit_notes c
           where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
          union all
          select to_char(d.debit_date, 'YYYY-MM'), coalesce(d.taxable_value, 0)::bigint, 0
            from public.debit_notes d
           where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
        ) k
       group by k.month
    ) m;
  return v_out;
end;
$function$;

create or replace function public.report_party_ledger(p_kind text, p_party text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cust   uuid;
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Ledger nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('customer', 'vendor') then
    raise exception 'Ledger ka prakaar "%" samajh nahi aaya — sirf customer ya vendor chalta hai.', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Ledger ki tareekh galat hai (% se % tak). Period dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  -- Customer id pehle hi uuid bana lo — query ke andar cast karte to vendor ke naam par
  -- bhi cast chal sakta (planner constant-fold karta hai) aur index bhi na lagta.
  if p_kind = 'customer' then
    begin
      v_cust := p_party::uuid;
    exception when invalid_text_representation then
      raise exception 'Customer id "%" sahi nahi hai. Customer list se dobara chunein.', p_party
        using errcode = 'invalid_parameter_value';
    end;
  end if;

  with e as (
    select * from (
      -- Customer: Sales (Dr), Receipt (Cr), Refund (Dr), Credit Note (Cr), Debit Note (Dr).
      select i.invoice_date as d, i.id as ref, 'Sales'::text as voucher, null::text as narr,
             i.amount::bigint as amt, true as up
        from public.invoices i
       where p_kind = 'customer' and i.tenant_id = v_tenant
         and i.customer_id = v_cust and i.status <> 'void'
      union all
      select (p.received_at at time zone 'Asia/Kolkata')::date, coalesce(p.receipt_voucher_no, p.id::text), 'Receipt',
             nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
             p.amount::bigint, false
        from public.payments p
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
      union all
      select (p.refunded_at at time zone 'Asia/Kolkata')::date,
             coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded', 'Refund',
             'Payment returned to the customer', p.amount::bigint, true
        from public.payments p
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
         and p.status = 'refunded' and p.refunded_at is not null
      union all
      select c.credit_date, c.id, 'Credit Note',
             coalesce(c.reason, case when coalesce(c.invoice_id, '') <> '' then 'against ' || c.invoice_id end),
             c.amount::bigint, false
        from public.credit_notes c
       where p_kind = 'customer' and c.tenant_id = v_tenant and c.customer_id = v_cust
      union all
      select d.debit_date, d.id, 'Debit Note',
             coalesce(d.reason, case when coalesce(d.invoice_id, '') <> '' then 'against ' || d.invoice_id end),
             d.amount::bigint, true
        from public.debit_notes d
       where p_kind = 'customer' and d.tenant_id = v_tenant and d.customer_id = v_cust
      union all
      -- Vendor: expenses hi bill hain (vendor_name par — vendor_id zyaadatar khaali hai).
      select x.expense_date, coalesce(x.bill_no, x.id), 'Purchase', x.category, x.amount::bigint, true
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
      union all
      select x.paid_date, coalesce(x.bill_no, x.id) || ' · paid', 'Payment', x.payment_method, x.amount::bigint, false
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
         and x.paid and x.paid_date is not null
    ) u
    where u.d is not null
  )
  select jsonb_build_object(
    'opening', (select coalesce(sum(case when e.up then e.amt else -e.amt end), 0) from e where e.d < p_from),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'date', to_char(e.d, 'YYYY-MM-DD'), 'reference', e.ref, 'voucher', e.voucher,
                  'narration', e.narr, 'amount', e.amt, 'increasesLiability', e.up)
                  order by e.d, e.up desc, e.ref), '[]'::jsonb)
                  from e where e.d between p_from and p_to)
  ) into v_out;
  return v_out;
end;
$function$;
