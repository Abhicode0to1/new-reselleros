-- 0123 — match ONE bank line to MULTIPLE expenses (split reconcile).
--
-- Generalises the "several things paid in one transfer" case: pick N expenses
-- that add up to a money-out bank line and reconcile them all at once. Because
-- salaries are booked as 'Salaries' expenses, this also covers "2 months'
-- salary in one RTGS" — matching those salary-expenses flips their salaries to
-- paid. The bank line is tagged 'split'.
--
-- Un-reconcile (matched_to_type → null) reverts everything: the salary trigger
-- already reopens the linked salaries; we extend it to also clear the expenses'
-- reconciled_txn_id.

alter table public.expenses
  add column if not exists reconciled_txn_id uuid references public.bank_transactions(id) on delete set null;

create or replace function public.reconcile_expenses_to_bank_txn(p_bank_txn_id uuid, p_expense_ids text[])
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
  v_want   integer := coalesce(array_length(p_expense_ids, 1), 0);
begin
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to expenses' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one expense to match'; end if;

  select coalesce(sum(amount), 0), count(*) into v_sum, v_cnt
  from public.expenses
  where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected expenses are missing or already reconciled — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected expenses total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.expenses set reconciled_txn_id = p_bank_txn_id
   where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id;

  -- Any of these that are salary-expenses → mark their salary paid + linked.
  update public.salary_payments sp
     set paid_status = 'paid', reconciled_txn_id = p_bank_txn_id
   where sp.tenant_id = v_txn.tenant_id and sp.expense_id = any (p_expense_ids) and sp.paid_status = 'unpaid';

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$function$;

grant execute on function public.reconcile_expenses_to_bank_txn(uuid, text[]) to authenticated;

-- Extend the reconcile trigger so un-reconciling a line also frees its expenses.
create or replace function public.sync_salary_paid_status()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.matched_to_type = 'salary' and new.matched_to_id is not null then
    update public.salary_payments set paid_status = 'paid', reconciled_txn_id = new.id
      where id = new.matched_to_id::uuid and tenant_id = new.tenant_id;
  elsif (tg_op = 'INSERT' or tg_op = 'UPDATE') and new.matched_to_type = 'expense' and new.matched_to_id is not null then
    update public.salary_payments set paid_status = 'paid', reconciled_txn_id = new.id
      where expense_id = new.matched_to_id and tenant_id = new.tenant_id;
  end if;
  if tg_op = 'UPDATE' and old.matched_to_type is not null and new.matched_to_type is null then
    update public.salary_payments set paid_status = 'unpaid', reconciled_txn_id = null where reconciled_txn_id = old.id;
    update public.expenses set reconciled_txn_id = null where reconciled_txn_id = old.id;
  end if;
  return new;
end; $function$;
