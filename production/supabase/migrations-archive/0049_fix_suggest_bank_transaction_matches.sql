-- 0049 — fix 0048's suggest_bank_transaction_matches.
--
-- The first version referenced p.customer_name on the payments table, which
-- doesn't exist (payments has customer_id only). Because plpgsql defers SQL
-- resolution to runtime, the CREATE FUNCTION succeeded but every invocation
-- would fail. This recreates the function using c.name from the LEFT JOIN
-- on customers + receipt_voucher_no as a fallback label.

create or replace function public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
returns table (
  match_type      text,
  match_id        text,
  match_label     text,
  match_amount    integer,
  match_date      date,
  match_confidence text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txn record;
  v_tenant uuid;
  v_search_amount integer;
  v_is_credit boolean;
begin
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  v_tenant := v_txn.tenant_id;
  v_search_amount := greatest(v_txn.debit, v_txn.credit);
  v_is_credit := v_txn.credit > 0;

  -- Credits (money in) → match against payments table (customer paid us)
  if v_is_credit then
    return query
    select 'payment'::text as match_type,
           p.id::text      as match_id,
           coalesce(c.name, p.receipt_voucher_no, 'Payment')
             || case when p.reference is not null and p.reference <> ''
                     then ' · ' || p.reference else '' end as match_label,
           p.amount        as match_amount,
           p.received_at::date as match_date,
           case
             when p.amount = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
             when p.amount = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high'
             else 'low'
           end::text       as match_confidence
    from public.payments p
    left join public.customers c on c.id = p.customer_id
    where p.tenant_id = v_tenant
      and p.status = 'received'
      and abs(p.amount - v_search_amount) <= 100
      and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs(p.amount - v_search_amount), abs(p.received_at::date - v_txn.txn_date)
    limit 5;
  end if;

  -- Debits (money out) → match against expenses (we paid someone)
  if not v_is_credit then
    return query
    select 'expense'::text as match_type,
           e.id::text      as match_id,
           coalesce(e.vendor_name, e.category, 'Expense') as match_label,
           e.amount        as match_amount,
           e.expense_date  as match_date,
           case
             when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
             when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high'
             else 'low'
           end::text       as match_confidence
    from public.expenses e
    where e.tenant_id = v_tenant
      and abs(e.amount - v_search_amount) <= 100
      and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date)
    limit 5;
  end if;
end;
$$;

grant execute on function public.suggest_bank_transaction_matches(uuid) to authenticated;
