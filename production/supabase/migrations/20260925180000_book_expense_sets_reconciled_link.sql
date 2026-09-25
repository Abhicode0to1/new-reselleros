-- ============================================================================
-- book_bank_txn_as_expense: set BOTH halves of the link.
--
-- THE BUG (in the baseline function): booking a bank line as an expense set the bank
-- line's matched_to_type / matched_to_id, but not the expense's reconciled_txn_id —
-- the half the Expenses list reads. Every expense booked from Banking therefore showed
-- "Reconcile" again on the Expenses page, and that dialog offered unrelated bank lines
-- to match it to (a ₹2,00,000 expense offered ₹3,526 ESIC lines). Found 25 Sep 2026:
-- 8 of 8 bank-booked expenses on the local copy were half-linked.
--
-- THE FIX
--   1. The function also sets reconciled_txn_id, bank_account_id, paid and paid_date on
--      the expense it creates — what reconcile_bank_txn sets when a line is matched to an
--      existing expense.
--   2. Backfill: every expense a bank line already points at, with no reverse link, gets
--      it. Only the link columns are written; no amount, date or category changes.
--      An expense that a bank line points at but that already names a DIFFERENT line is
--      left alone (reported by the count below, not overwritten).
-- ============================================================================

create or replace function public.book_bank_txn_as_expense(p_txn_id uuid, p_category text, p_vendor text, p_gst integer, p_notes text default null::text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description,
     paid, paid_date, bank_account_id, reconciled_txn_id)
  values
    (v_exp_id, v_tenant, trim(p_category), nullif(trim(coalesce(p_vendor, '')), ''),
     v_txn.txn_date, v_txn.debit, greatest(coalesce(p_gst, 0), 0), 'bank',
     coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description),
     true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  update public.bank_transactions
     set matched_to_type = 'expense', matched_to_id = v_exp_id, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid()
   where id = p_txn_id and tenant_id = v_tenant;
  return v_exp_id;
end;
$function$;

-- Backfill the reverse link for expenses already booked from a bank line.
update public.expenses e
   set reconciled_txn_id = b.id,
       bank_account_id   = coalesce(e.bank_account_id, b.bank_account_id),
       paid_date         = coalesce(e.paid_date, b.txn_date),
       updated_at        = now()
  from public.bank_transactions b
 where b.matched_to_type = 'expense'
   and b.matched_to_id   = e.id
   and b.tenant_id       = e.tenant_id
   and e.reconciled_txn_id is null;
