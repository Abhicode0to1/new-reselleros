-- 0132: Book an unmatched money-IN bank line as capital / a director's loan,
-- in ONE step — the mirror of book_bank_txn_as_expense (money-out).
--
-- Opening a company account, a promoter puts money in. That credit is NOT
-- income — it's either owner's capital (equity) or a director's loan the
-- company must repay (liability). Previously the operator had to reconcile the
-- bank line AND separately add a Balance-Sheet line — two disconnected entries.
-- This books both atomically and links them, so un-reconciling the bank line
-- cleanly removes the classification too (see the reconcile hook).

alter table public.balance_sheet_items
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null;

create index if not exists balance_sheet_items_bank_txn_idx
  on public.balance_sheet_items(bank_txn_id) where bank_txn_id is not null;

-- Book a credit line as owner's capital (equity) or a director's loan (liability),
-- and mark the bank line reconciled. Atomic + tenant-scoped.
create or replace function public.book_bank_credit(
  p_txn_id uuid,
  p_kind   text,          -- 'capital' | 'director_loan'
  p_label  text,
  p_notes  text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_section text;
  v_label   text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'This is only for money-in (credit) lines';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;

  v_section := case p_kind
                 when 'capital'       then 'equity'
                 when 'director_loan' then 'liability'
                 else null end;
  if v_section is null then raise exception 'Unknown kind: %', p_kind; end if;

  v_label := coalesce(nullif(trim(p_label), ''),
                      case p_kind when 'capital' then 'Owner''s capital' else 'Director''s loan' end);

  insert into public.balance_sheet_items (tenant_id, section, label, amount, notes, bank_txn_id)
  values (v_tenant, v_section, v_label, v_txn.credit, nullif(trim(coalesce(p_notes, '')), ''), p_txn_id);

  update public.bank_transactions
     set matched_to_type = 'manual', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual',
         updated_at = now()
   where id = p_txn_id;
end;
$$;

grant execute on function public.book_bank_credit(uuid, text, text, text) to authenticated;
