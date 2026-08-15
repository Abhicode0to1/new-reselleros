-- 0122 — match ONE bank line to MULTIPLE salaries (split reconcile).
--
-- When several salaries are paid in a single bank transfer (e.g. 2 months'
-- director salary ₹90,000 + ₹1,10,000 = ₹2,00,000 in one RTGS), the 1:1
-- reconcile suggester finds nothing (no single record ≈ the line). This adds a
-- 'split' match: the bank line is tagged 'split' and each selected salary is
-- marked paid + linked to it. The existing sync_salary_paid_status trigger
-- already reverts ALL salaries with reconciled_txn_id = <line> on un-reconcile,
-- so undo just works.

alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check;
alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check
  check (matched_to_type = any (array['payment','expense','vendor_bill','transfer','salary','project','manual','split']::text[]));

create or replace function public.reconcile_salaries_to_bank_txn(p_bank_txn_id uuid, p_salary_ids uuid[])
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_sum    integer;
  v_cnt    integer;
  v_want   integer := coalesce(array_length(p_salary_ids, 1), 0);
begin
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to salaries' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one salary to match'; end if;

  -- Only unpaid, unlinked salaries in this tenant count.
  select coalesce(sum(net), 0), count(*) into v_sum, v_cnt
  from public.salary_payments
  where id = any (p_salary_ids) and tenant_id = v_txn.tenant_id
    and paid_status = 'unpaid' and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected salaries are missing or already paid — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected salaries total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.salary_payments
     set paid_status = 'paid', reconciled_txn_id = p_bank_txn_id
   where id = any (p_salary_ids) and tenant_id = v_txn.tenant_id;

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$function$;

grant execute on function public.reconcile_salaries_to_bank_txn(uuid, uuid[]) to authenticated;
