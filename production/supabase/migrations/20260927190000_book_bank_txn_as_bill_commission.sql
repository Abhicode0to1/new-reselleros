-- Vendor bill / referral commission paid from an IMPORTED bank line — no phantom
-- line (27 Sep 2026).
--
-- pay_vendor_bill and pay_referral_commission each INSERT a 'manual' bank line for the
-- payment. When the statement is imported later, the real debit arrives as a second
-- line — the same money twice in cash & bank, and an "unmatched" line that can only
-- be reconciled by hand-deleting the synthetic one. book_bank_txn_as_statutory /
-- _as_expense / _as_prepaid already do this the right way: settle the thing against
-- the imported line. These two do the same for bills and commissions.
--
--   book_bank_txn_as_vendor_bill(p_txn_id, p_bill_id, p_method)
--     · the line's debit is the payment (≤ outstanding; partial allowed)
--     · if pay_vendor_bill had already booked this payment as a synthetic line for the
--       same bill and amount, that synthetic line is REMOVED and the bill left as it is
--       (already counted) — the imported line simply takes its place
--   book_bank_txn_as_referral_commission(p_txn_id, p_commission_id)
--     · the line's debit must equal the commission's net payable
--     · same synthetic-line replacement; referral_commissions.pay_txn_id now points at
--       the bank line that paid it

-- Found while testing: pay_referral_commission tags its line 'referral_commission', a
-- value the check constraint never allowed — so paying a commission from the Referrals
-- page has failed since the constraint was last rewritten (20260925160000). Allowed now.
alter table public.bank_transactions drop constraint if exists bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array['payment','expense','vendor_bill','transfer','salary','project','manual','split','statutory','prepaid','referral_commission']));

create or replace function public.book_bank_txn_as_vendor_bill(p_txn_id uuid, p_bill_id text, p_method text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
  v_bill public.vendor_bills;
  v_synth uuid;
  v_outstanding integer;
  v_new_paid integer;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A bill payment must be a money-out line'; end if;

  select * into v_bill from public.vendor_bills where id = p_bill_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bill not found'; end if;

  -- The same payment already booked from the Bills page as a synthetic line? Replace it.
  select id into v_synth from public.bank_transactions
   where tenant_id = v_tenant and id <> p_txn_id and source = 'manual'
     and matched_to_type = 'vendor_bill' and matched_to_id = p_bill_id
     and debit = v_txn.debit
   order by abs(txn_date - v_txn.txn_date) limit 1;

  if v_synth is not null then
    delete from public.bank_transactions where id = v_synth;
  else
    v_outstanding := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
    if v_txn.debit > v_outstanding then
      raise exception 'Line (%) is more than the bill''s outstanding (%) — split the line, or pick the right bill', v_txn.debit, v_outstanding;
    end if;
    v_new_paid := coalesce(v_bill.paid_amount, 0) + v_txn.debit;
    update public.vendor_bills
       set paid_amount = v_new_paid,
           status = case when v_new_paid >= coalesce(total, 0) then 'paid' else 'partial' end,
           updated_at = now()
     where id = p_bill_id;
  end if;

  update public.bank_transactions
     set matched_to_type = 'vendor_bill', matched_to_id = p_bill_id, match_confidence = 'manual',
         reference = coalesce(nullif(trim(coalesce(p_method, '')), ''), reference),
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('bill_id', p_bill_id, 'replaced_synthetic', v_synth, 'amount', v_txn.debit);
end; $$;
revoke execute on function public.book_bank_txn_as_vendor_bill(uuid, text, text) from public, anon;
grant execute on function public.book_bank_txn_as_vendor_bill(uuid, text, text) to authenticated, service_role;

create or replace function public.book_bank_txn_as_referral_commission(p_txn_id uuid, p_commission_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
  v_comm public.referral_commissions;
  v_synth uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A commission payment must be a money-out line'; end if;

  select * into v_comm from public.referral_commissions where id = p_commission_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status = 'cancelled' then raise exception 'Commission is cancelled'; end if;
  if v_txn.debit <> v_comm.net_payable then
    raise exception 'Line (%) is not the commission''s net payable (%) — commissions are paid in full', v_txn.debit, v_comm.net_payable;
  end if;

  select id into v_synth from public.bank_transactions
   where tenant_id = v_tenant and id <> p_txn_id and source = 'manual'
     and matched_to_type = 'referral_commission' and matched_to_id = p_commission_id::text
   order by abs(txn_date - v_txn.txn_date) limit 1;

  if v_synth is not null then
    delete from public.bank_transactions where id = v_synth;
  elsif v_comm.status = 'paid' then
    raise exception 'Commission already paid (and its bank line is not a synthetic one) — un-reconcile that first';
  end if;

  update public.referral_commissions
     set status = 'paid', paid_date = coalesce(paid_date, v_txn.txn_date), pay_txn_id = p_txn_id
   where id = p_commission_id;

  update public.bank_transactions
     set matched_to_type = 'referral_commission', matched_to_id = p_commission_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('commission_id', p_commission_id, 'replaced_synthetic', v_synth, 'amount', v_txn.debit);
end; $$;
revoke execute on function public.book_bank_txn_as_referral_commission(uuid, uuid) from public, anon;
grant execute on function public.book_bank_txn_as_referral_commission(uuid, uuid) to authenticated, service_role;
