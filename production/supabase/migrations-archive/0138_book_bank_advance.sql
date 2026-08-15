-- 0138: Book an unmatched bank line as money GIVEN TO / RETURNED BY a person
-- (a loan / advance) — NOT income and NOT expense.
--
-- Scenario: you paid someone (e.g. a temporary loan/advance) and later they
-- returned it. Booking the out-leg as an "expense" and the in-leg as "income /
-- capital" would wrongly inflate the P&L for money that was only lent, then
-- repaid. Correct treatment is a balance-sheet ASSET ("Loans & advances given"):
--   • money OUT  → asset increases (they owe you)
--   • money IN   → asset decreases (offsets it; net zero once fully returned)
-- P&L is never touched. Mirrors book_bank_credit — atomic, tenant-scoped, and
-- linked via bank_txn_id so un-reconciling the line removes the classification.

create or replace function public.book_bank_advance(
  p_txn_id       uuid,
  p_counterparty text,
  p_notes        text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_amount int;
  v_label  text;
  v_party  text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_party := nullif(trim(coalesce(p_counterparty, '')), '');

  if coalesce(v_txn.debit, 0) > 0 then
    -- money OUT = loan/advance GIVEN → asset increases
    v_amount := v_txn.debit;
    v_label  := 'Advance/loan given' || coalesce(' · ' || v_party, '');
  elsif coalesce(v_txn.credit, 0) > 0 then
    -- money IN = advance RETURNED → asset decreases (net to zero once repaid)
    v_amount := -v_txn.credit;
    v_label  := 'Advance/loan returned' || coalesce(' · ' || v_party, '');
  else
    raise exception 'Transaction has no amount';
  end if;

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, 'asset', v_label, v_amount, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id);

  update public.bank_transactions
     set matched_to_type = 'manual', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$$;

grant execute on function public.book_bank_advance(uuid, text, text) to authenticated;
