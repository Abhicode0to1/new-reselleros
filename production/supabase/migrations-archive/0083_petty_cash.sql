-- 0083: Petty cash / cash-in-hand support.
--
-- A "cash" account is just a bank_account with account_type='cash'. Its balance
-- is computed by the existing bank_account_current_balance() RPC
-- (opening + credits − debits), so no new balance machinery is needed:
--   • Withdraw cash from bank  → transfer: bank debit + cash credit
--   • Spend petty cash         → cash debit (created alongside the expense)
--   • Cash in hand             → the cash account's current_balance
--
-- Cash accounts have no IFSC / account number, so those two columns become
-- nullable (they stay required in the UI only for real bank accounts).

-- 1. Allow the 'cash' account type.
alter table public.bank_accounts drop constraint if exists bank_accounts_account_type_check;
alter table public.bank_accounts add constraint bank_accounts_account_type_check
  check (account_type in ('current', 'savings', 'overdraft', 'fixed_deposit', 'cash', 'other'));

-- 2. IFSC + last4 are not applicable to a cash account.
alter table public.bank_accounts alter column ifsc drop not null;
alter table public.bank_accounts alter column account_number_last4 drop not null;

-- 3. Atomic transfer between two of the tenant's own accounts (e.g. bank → petty
--    cash withdrawal). Two legs in one transaction so a mid-flight failure can't
--    leave a one-sided entry. SECURITY DEFINER but strictly tenant-scoped: both
--    accounts must belong to the caller's tenant.
create or replace function public.record_account_transfer(
  p_from_account uuid,
  p_to_account   uuid,
  p_amount       integer,
  p_txn_date     date,
  p_note         text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_from_name text;
  v_to_name   text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Transfer amount must be positive';
  end if;
  if p_from_account = p_to_account then
    raise exception 'Cannot transfer to the same account';
  end if;

  select name into v_from_name from public.bank_accounts
    where id = p_from_account and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  select name into v_to_name from public.bank_accounts
    where id = p_to_account and tenant_id = v_tenant;
  if not found then raise exception 'Destination account not found'; end if;

  -- Leg 1: money leaves the source account
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_from_account, p_txn_date,
     coalesce(nullif(p_note, ''), 'Transfer to ' || v_to_name),
     p_amount, 0, 'manual', 'transfer', 'manual');

  -- Leg 2: money arrives in the destination account
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_to_account, p_txn_date,
     coalesce(nullif(p_note, ''), 'Transfer from ' || v_from_name),
     0, p_amount, 'manual', 'transfer', 'manual');
end;
$$;

grant execute on function public.record_account_transfer(uuid, uuid, integer, date, text) to authenticated;
