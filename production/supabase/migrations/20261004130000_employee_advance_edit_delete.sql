-- 4 Oct 2026 — correct or remove an employee advance made by mistake (Pardeep: "galti se
-- ban gaya, isko delete ya edit karne ka system hona chahiye").
--
-- An advance is a prepaid_advances row (category 'Employee advance'); petty-cash advances
-- also carry cash lines in bank_transactions (matched_to_type 'prepaid', matched_to_id =
-- advance id) for the disbursal, every top-up and the settlement — see
-- 20261001150000_employee_advance_prepaid.sql. Expenses spent from it point at it through
-- expenses.prepaid_advance_id, and tg_expense_employee_advance keeps consumed_amount right.
--
-- Rules (designed for how this breaks, not only the happy path):
--   · Owner / manager / accountant / billing only — the people who give advances.
--   · The books lock (tg_books_locked) still applies to every row touched here, so a
--     locked month cannot be rewritten through these functions.
--   · EDIT: name and purpose always; amount and date only while the advance is open and has
--     had no top-up (the disbursal line would no longer be the whole amount). The amount
--     can never drop below what has already been spent.
--   · DELETE: refused while expenses are booked against it, unless the caller explicitly
--     asks to delete those too (the UI lists them first). Cash lines this advance created
--     on petty cash are deleted; a bank / UPI statement line matched to it is only
--     un-matched — a real statement line is never deleted.

create or replace function public.update_employee_advance(
  p_advance_id uuid,
  p_name       text,
  p_amount     int,
  p_date       date,
  p_note       text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
  v_name   text := nullif(trim(coalesce(p_name, '')), '');
  v_money_changed boolean;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can change an advance.';
  end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;
  if v_name is null then raise exception 'Enter who you gave the money to.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;

  v_money_changed := p_amount <> v_adv.total_amount or coalesce(p_date, v_adv.paid_date) <> v_adv.paid_date;
  if v_money_changed then
    if v_adv.closed_at is not null then
      raise exception 'This advance is settled — the amount and date can no longer change. Fix the name or purpose only.';
    end if;
    if coalesce(v_adv.notes, '') ~ 'Top-up ₹' then
      raise exception 'This advance has a top-up, so its amount cannot be edited. Delete it and give it again instead.';
    end if;
    if p_amount < v_adv.consumed_amount then
      raise exception '₹% is already spent from this advance — the amount cannot be less than that.', v_adv.consumed_amount;
    end if;
  end if;

  update public.prepaid_advances
     set vendor_name  = v_name,
         total_amount = p_amount,
         paid_date    = coalesce(p_date, paid_date),
         -- notes = purpose (first line) + the history lines top-up / settle append. Only the
         -- purpose is replaced; the history stays (it is also what the top-up check reads).
         notes        = nullif(concat_ws(E'\n',
                          nullif(trim(coalesce(p_note, '')), ''),
                          (select string_agg(l, E'\n' order by n)
                             from unnest(string_to_array(coalesce(v_adv.notes, ''), E'\n')) with ordinality as h(l, n)
                            where l ~ '^(Top-up ₹|Settled on )')), ''),
         updated_at   = now()
   where id = p_advance_id;

  -- Keep the petty-cash disbursal line in step (bank / UPI advances have none).
  if v_adv.bank_txn_id is not null then
    update public.bank_transactions
       set debit = p_amount, txn_date = coalesce(p_date, txn_date), description = 'Advance to ' || v_name
     where id = v_adv.bank_txn_id and tenant_id = v_tenant and source = 'manual';
  end if;
end $$;

create or replace function public.delete_employee_advance(
  p_advance_id      uuid,
  p_delete_expenses boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
  v_n_exp  int;
  v_sum    bigint;
  v_lines  int;
  v_unmatched int;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can delete an advance.';
  end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;

  select count(*), coalesce(sum(amount), 0) into v_n_exp, v_sum
    from public.expenses where tenant_id = v_tenant and prepaid_advance_id = p_advance_id;
  if v_n_exp > 0 and not coalesce(p_delete_expenses, false) then
    raise exception '% expense(s) worth ₹% are booked against this advance. Delete them too, or delete them first.', v_n_exp, v_sum
      using errcode = 'P0001', hint = 'has_expenses';
  end if;

  -- Expenses first: the expense trigger needs the advance row to still exist.
  delete from public.expenses where tenant_id = v_tenant and prepaid_advance_id = p_advance_id;

  -- Petty-cash lines this advance wrote (disbursal, top-ups, settlement). Unhook the
  -- disbursal pointer first so its foreign key does not block the delete.
  update public.prepaid_advances set bank_txn_id = null where id = p_advance_id;
  delete from public.bank_transactions
   where tenant_id = v_tenant and source = 'manual'
     and matched_to_type = 'prepaid' and matched_to_id = p_advance_id::text;
  get diagnostics v_lines = row_count;

  -- A real statement line matched to this advance is kept, only un-matched.
  update public.bank_transactions
     set matched_to_type = null, matched_to_id = null, match_confidence = null, matched_at = null, matched_by = null
   where tenant_id = v_tenant and source <> 'manual'
     and matched_to_type = 'prepaid' and matched_to_id = p_advance_id::text;
  get diagnostics v_unmatched = row_count;

  delete from public.prepaid_advances where id = p_advance_id;

  return jsonb_build_object('expenses_deleted', v_n_exp, 'cash_lines_deleted', v_lines, 'bank_lines_unmatched', v_unmatched);
end $$;

revoke all on function public.update_employee_advance(uuid, text, int, date, text) from public;
revoke all on function public.delete_employee_advance(uuid, boolean) from public;
grant execute on function public.update_employee_advance(uuid, text, int, date, text) to authenticated, service_role;
grant execute on function public.delete_employee_advance(uuid, boolean) to authenticated, service_role;
