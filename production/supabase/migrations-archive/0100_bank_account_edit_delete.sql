-- 0100: Delete a bank account (tenant-scoped, atomic).
--
-- FK behaviour already defined on the referencing tables:
--   • bank_transactions       → ON DELETE CASCADE   (its ledger lines go too)
--   • bank_aa_connections     → ON DELETE CASCADE
--   • payments / salary_payments / employee_loans / employee_loan_repayments
--     / emi_payments / emi_purchases / statutory_dues_payments
--                             → ON DELETE SET NULL  (record survives, loses
--                                the "paid via" account link)
--
-- So deleting is FK-safe (no orphan errors). It IS destructive — every
-- imported transaction on the account is permanently removed. The UI shows a
-- dependency preview + a typed confirmation before calling this. Editing an
-- account (incl. its opening balance) is a plain RLS-scoped UPDATE — no RPC.

create or replace function public.delete_bank_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  perform 1 from public.bank_accounts
    where id = p_account_id and tenant_id = v_tenant;
  if not found then
    raise exception 'Bank account not found';
  end if;

  -- CASCADE / SET NULL rules on the FKs do the rest atomically.
  delete from public.bank_accounts
    where id = p_account_id and tenant_id = v_tenant;
end;
$$;

grant execute on function public.delete_bank_account(uuid) to authenticated;
