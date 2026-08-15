-- 0135: record a payment against a vendor bill (atomic).
--
-- Adds to the bill's paid_amount, flips status (partial → paid), AND debits the
-- chosen bank account (money out) with the line linked back to the bill, so
-- cash flow + reconciliation stay correct. Multi-row → SECURITY DEFINER RPC
-- per CLAUDE.md §17b.

create or replace function public.pay_vendor_bill(
  p_bill_id         text,
  p_amount          integer,
  p_paid_on         date,
  p_bank_account_id uuid,
  p_method          text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_bill        public.vendor_bills;
  v_outstanding integer;
  v_new_paid    integer;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;

  select * into v_bill from public.vendor_bills where id = p_bill_id and tenant_id = v_tenant;
  if not found then raise exception 'Bill not found'; end if;

  v_outstanding := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
  if p_amount > v_outstanding then
    raise exception 'Payment (%) exceeds the outstanding (%)', p_amount, v_outstanding;
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  v_new_paid := coalesce(v_bill.paid_amount, 0) + p_amount;
  update public.vendor_bills
     set paid_amount = v_new_paid,
         status      = case when v_new_paid >= coalesce(total, 0) then 'paid' else 'partial' end,
         updated_at  = now()
   where id = p_bill_id;

  -- Money leaves the bank, linked to this bill.
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, current_date),
     'Bill payment: ' || v_bill.vendor_name, p_amount, 0, 'manual', 'vendor_bill', p_bill_id, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));
end;
$$;

grant execute on function public.pay_vendor_bill(text, integer, date, uuid, text) to authenticated;
