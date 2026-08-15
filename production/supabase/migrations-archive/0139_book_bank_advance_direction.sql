-- 0139: extend book_bank_advance with a DIRECTION so it handles both sides of a
-- person-to-person loan/advance correctly (supersedes the 3-arg 0138 version):
--
--   p_kind = 'given'    → I am the LENDER  → balance-sheet ASSET
--       money OUT (debit)  = loan/advance GIVEN     → asset +   (they owe me)
--       money IN  (credit) = that advance RETURNED  → asset −   (settles)
--
--   p_kind = 'received' → I am the BORROWER → balance-sheet LIABILITY
--       money IN  (credit) = loan RECEIVED from them → liability +  (I owe them)
--       money OUT (debit)  = that loan REPAID        → liability −  (settles)
--
-- Either way it's NOT income and NOT expense — the P&L is never touched; the
-- pair nets to zero once fully settled. Linked via bank_txn_id so un-reconciling
-- removes the classification.

drop function if exists public.book_bank_advance(uuid, text, text);

create or replace function public.book_bank_advance(
  p_txn_id       uuid,
  p_counterparty text,
  p_kind         text default 'given',   -- 'given' (asset) | 'received' (liability)
  p_notes        text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_amount  int;
  v_section text;
  v_label   text;
  v_party   text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_party := nullif(trim(coalesce(p_counterparty, '')), '');

  if p_kind = 'given' then
    -- I lent → ASSET
    v_section := 'asset';
    if coalesce(v_txn.debit, 0) > 0 then
      v_amount := v_txn.debit;
      v_label  := 'Advance/loan given' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.credit, 0) > 0 then
      v_amount := -v_txn.credit;
      v_label  := 'Advance/loan returned' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  elsif p_kind = 'received' then
    -- I borrowed → LIABILITY
    v_section := 'liability';
    if coalesce(v_txn.credit, 0) > 0 then
      v_amount := v_txn.credit;
      v_label  := 'Loan received' || coalesce(' · ' || v_party, '');
    elsif coalesce(v_txn.debit, 0) > 0 then
      v_amount := -v_txn.debit;
      v_label  := 'Loan repaid' || coalesce(' · ' || v_party, '');
    else
      raise exception 'Transaction has no amount';
    end if;
  else
    raise exception 'Unknown kind: %', p_kind;
  end if;

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_amount, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id);

  update public.bank_transactions
     set matched_to_type = 'manual', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$$;

grant execute on function public.book_bank_advance(uuid, text, text, text) to authenticated;
