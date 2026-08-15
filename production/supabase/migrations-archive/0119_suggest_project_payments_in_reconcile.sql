-- 0119 — reconcile suggester also offers PROJECT payments for money-in lines.
--
-- suggest_bank_transaction_matches only looked at subscription `payments` for
-- credits, so a project-sale receipt (e.g. the ₹5,40,000 Excel advance) never
-- appeared as a suggested match — the operator saw "No close matches found"
-- even though an exact project payment existed. Add un-reconciled project
-- payments (bank_txn_id is null) to the credit-side suggestions.

create or replace function public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
 returns table(match_type text, match_id text, match_label text, match_amount integer, match_date date, match_confidence text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
begin
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  if v_is_credit then
    -- Subscription payments
    return query
    select 'payment'::text, p.id::text,
           coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end,
           p.amount, p.received_at::date,
           case when p.amount = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
                when p.amount = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.payments p left join public.customers c on c.id = p.customer_id
    where p.tenant_id = v_tenant and p.status = 'received' and abs(p.amount - v_search_amount) <= 100 and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs(p.amount - v_search_amount), abs(p.received_at::date - v_txn.txn_date) limit 5;

    -- Project-sale payments not yet linked to a bank line
    return query
    select 'project'::text, pp.id::text,
           coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project',
           pp.amount, pp.received_at::date,
           case when pp.amount = v_search_amount and pp.received_at::date = v_txn.txn_date then 'exact'
                when pp.amount = v_search_amount and abs(pp.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.project_payments pp
    join public.project_sales ps on ps.id = pp.project_id
    where pp.tenant_id = v_tenant and pp.bank_txn_id is null
      and abs(pp.amount - v_search_amount) <= 100 and abs(pp.received_at::date - v_txn.txn_date) <= 7
    order by abs(pp.amount - v_search_amount), abs(pp.received_at::date - v_txn.txn_date) limit 5;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries' and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $function$;
