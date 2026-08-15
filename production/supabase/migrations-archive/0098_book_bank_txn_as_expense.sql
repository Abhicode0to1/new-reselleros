-- 0098: Book an imported bank line directly as an expense (+ reconcile it).
--
-- For a money-OUT (debit) statement line that isn't already in the books, the
-- operator can categorise it as a company expense in one step. Crucially this
-- does NOT create a new bank_transactions leg — the imported line IS the cash
-- movement, so we only create the expense and point the line at it. That keeps
-- the P&L correct (expense recorded) with no double-counting of cash.
--
-- Money-out only. Income / owner-drawings / transfers keep the existing
-- match-or-mark-reconciled paths (those don't hit the P&L as an expense).

create or replace function public.book_bank_txn_as_expense(
  p_txn_id   uuid,
  p_category text,
  p_vendor   text,
  p_gst      integer,
  p_notes    text default null
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_exp_id text;
begin
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;

  select * into v_txn from public.bank_transactions
    where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Transaction not found'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) line can be booked as an expense';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));

  -- Expense only — NO bank leg (the imported line already moved the cash).
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, trim(p_category), nullif(trim(coalesce(p_vendor, '')), ''),
     v_txn.txn_date, v_txn.debit, greatest(coalesce(p_gst, 0), 0), 'bank',
     coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description));

  -- Point the bank line at the new expense (reconciled).
  update public.bank_transactions
     set matched_to_type = 'expense', matched_to_id = v_exp_id, match_confidence = 'manual'
   where id = p_txn_id and tenant_id = v_tenant;

  return v_exp_id;
end;
$$;

grant execute on function public.book_bank_txn_as_expense(uuid, text, text, integer, text) to authenticated;
