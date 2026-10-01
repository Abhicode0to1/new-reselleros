-- ============================================================================
-- R-101 (1 Oct 2026) — staff / peon expense advances, done the way the books need it.
--
-- THE CASE (Pardeep): "mera ek peon hai use advance me kharche ke liye dene hote hai".
-- In a visible demo on localhost the existing Advances page broke on its first real use:
--
--   1. Recording a spend from an advance ALWAYS failed ("[object Object]" on screen):
--        insert or update on table "expenses" violates foreign key constraint
--        "expenses_prepaid_advance_id_fkey"
--      The page stored the advance itself as an `expenses` row (category 'Employee Advance
--      Disbursal') and then put THAT expense's id into expenses.prepaid_advance_id — a
--      column whose FK (0209) points at prepaid_advances. No spend could ever be saved,
--      in production either.
--   2. The advance was booked as an EXPENSE. Money handed to a peon is still the company's
--      money, just in someone else's pocket — an asset. Booking the ₹5,000 as an expense
--      and then each ₹200 bill again counted the same money twice in the P&L.
--   3. Its own little form had no way to attach the bill.
--
-- WHAT THIS DOES
--   A staff advance is now a prepaid_advances row with category 'Employee advance' —
--   the same asset model the vendor/Facebook advances already use (balance sheet,
--   consumed_amount, bills listed per advance). Spends are ordinary expenses written by
--   the normal Expense form, with payment_method = 'employee_advance' and
--   prepaid_advance_id = the advance; a trigger keeps consumed_amount right:
--     • insert  → refuses more than what is left, a closed advance, or another
--                 company's advance; otherwise adds the amount;
--     • update  → moves the amount between advances / re-checks the new amount;
--     • delete  → gives the amount back to the advance.
--   The two existing consume RPCs write payment_method 'advance' and bump the counter
--   themselves — the trigger ignores them, so nothing is counted twice.
--
--   RPCs: give_employee_advance, top_up_employee_advance, settle_employee_advance.
--   Cash accounts (account_type 'cash' — petty cash) get the matching cash line so the
--   cash-in-hand balance follows; bank / UPI money is matched from the bank statement in
--   Banking, exactly like a vendor advance.
--
--   Data: every old 'Employee Advance Disbursal' expense becomes an advance (its bank
--   line, if reconciled, is re-pointed) and the expense row is removed from the P&L.
-- ============================================================================

alter table public.prepaid_advances add column if not exists closed_at timestamptz;
comment on column public.prepaid_advances.closed_at is
  'Staff advance settled (left-over cash returned). NULL = open. Only used for category ''Employee advance''.';

-- ── 1. Spend trigger ─────────────────────────────────────────────────────────
create or replace function public.tg_expense_employee_advance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adv  public.prepaid_advances;
  v_left int;
begin
  -- Give the old amount back (update / delete of a spend).
  if tg_op in ('UPDATE', 'DELETE')
     and old.payment_method = 'employee_advance' and old.prepaid_advance_id is not null then
    update public.prepaid_advances
       set consumed_amount = greatest(0, consumed_amount - coalesce(old.amount, 0)), updated_at = now()
     where id = old.prepaid_advance_id;
  end if;

  if tg_op = 'DELETE' then return old; end if;

  -- Take the new amount (insert / update of a spend).
  if new.payment_method = 'employee_advance' then
    if new.prepaid_advance_id is null then
      raise exception 'Pick which advance this was paid from.' using errcode = 'check_violation';
    end if;
    select * into v_adv from public.prepaid_advances
     where id = new.prepaid_advance_id and tenant_id = new.tenant_id and category = 'Employee advance'
     for update;
    if not found then
      raise exception 'That advance was not found.' using errcode = 'check_violation';
    end if;
    if v_adv.closed_at is not null then
      raise exception 'The advance with % is settled. Give a new advance or a top-up first.', v_adv.vendor_name
        using errcode = 'check_violation';
    end if;
    v_left := v_adv.total_amount - v_adv.consumed_amount;
    if coalesce(new.amount, 0) <= 0 then
      raise exception 'Amount must be more than ₹0.' using errcode = 'check_violation';
    end if;
    if new.amount > v_left then
      raise exception 'Only ₹% is left with %. Give a top-up first, or enter ₹% or less.', v_left, v_adv.vendor_name, v_left
        using errcode = 'check_violation';
    end if;
    update public.prepaid_advances
       set consumed_amount = consumed_amount + new.amount, updated_at = now()
     where id = v_adv.id;
    -- Paid from cash already in the person's hand: no bank / petty-cash leg of its own.
    new.paid            := true;
    new.paid_date       := coalesce(new.paid_date, new.expense_date);
    new.bank_account_id := null;
  end if;

  return new;
end $$;

drop trigger if exists trg_expense_employee_advance on public.expenses;
create trigger trg_expense_employee_advance
  before insert or update of amount, payment_method, prepaid_advance_id or delete on public.expenses
  for each row execute function public.tg_expense_employee_advance();

-- ── 2. Cash leg helper (petty cash only) ─────────────────────────────────────
create or replace function public._employee_advance_cash_leg(
  p_tenant uuid, p_account uuid, p_date date, p_debit int, p_credit int, p_text text, p_adv uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_account is null then return null; end if;
  if not exists (select 1 from public.bank_accounts
                  where id = p_account and tenant_id = p_tenant and account_type = 'cash') then
    return null;   -- a bank / UPI account: matched from the statement in Banking instead
  end if;
  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
     matched_to_type, matched_to_id, match_confidence, matched_at, matched_by)
  values
    (p_tenant, p_account, p_date, p_text, p_debit, p_credit, 'manual',
     'prepaid', p_adv::text, 'manual', now(), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public._employee_advance_cash_leg(uuid, uuid, date, int, int, text, uuid) from public;

-- ── 3. Give / top up / settle ────────────────────────────────────────────────
create or replace function public.give_employee_advance(
  p_name        text,
  p_amount      int,
  p_date        date default current_date,
  p_method      text default 'cash',
  p_account     uuid default null,
  p_note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_leg    uuid;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Enter who you gave the money to.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  if p_account is not null and not exists (select 1 from public.bank_accounts where id = p_account and tenant_id = v_tenant) then
    raise exception 'That bank / cash account is not in your company.';
  end if;

  insert into public.prepaid_advances
    (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method,
     bank_account_id, notes, created_by)
  values
    (v_tenant, trim(p_name), 'Employee advance', p_amount, 0, coalesce(p_date, current_date), p_method,
     p_account, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;

  v_leg := public._employee_advance_cash_leg(v_tenant, p_account, coalesce(p_date, current_date), p_amount, 0,
                                             'Advance to ' || trim(p_name), v_id);
  if v_leg is not null then
    update public.prepaid_advances set bank_txn_id = v_leg where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.top_up_employee_advance(
  p_advance_id uuid,
  p_amount     int,
  p_date       date default current_date,
  p_account    uuid default null
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;

  update public.prepaid_advances
     set total_amount = total_amount + p_amount, closed_at = null, updated_at = now(),
         notes = concat_ws(E'\n', notes, 'Top-up ₹' || p_amount || ' on ' || to_char(coalesce(p_date, current_date), 'DD Mon YYYY'))
   where id = p_advance_id;

  perform public._employee_advance_cash_leg(v_tenant, coalesce(p_account, v_adv.bank_account_id), coalesce(p_date, current_date),
                                            p_amount, 0, 'Advance top-up to ' || v_adv.vendor_name, p_advance_id);
  return v_adv.total_amount + p_amount - v_adv.consumed_amount;
end $$;

-- Settle: the person hands back what is left. The advance shrinks to what was spent
-- (so the asset leaves the balance sheet) and is marked closed.
create or replace function public.settle_employee_advance(
  p_advance_id uuid,
  p_date       date default current_date,
  p_account    uuid default null
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_adv      public.prepaid_advances;
  v_returned int;
begin
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;
  if v_adv.closed_at is not null then raise exception 'This advance is already settled.'; end if;

  v_returned := v_adv.total_amount - v_adv.consumed_amount;
  update public.prepaid_advances
     set total_amount = consumed_amount, closed_at = now(), updated_at = now(),
         notes = concat_ws(E'\n', notes, 'Settled on ' || to_char(coalesce(p_date, current_date), 'DD Mon YYYY')
                                         || ' · ₹' || v_returned || ' returned')
   where id = p_advance_id;

  if v_returned > 0 then
    perform public._employee_advance_cash_leg(v_tenant, coalesce(p_account, v_adv.bank_account_id), coalesce(p_date, current_date),
                                              0, v_returned, 'Advance returned by ' || v_adv.vendor_name, p_advance_id);
  end if;
  return v_returned;
end $$;

revoke all on function public.give_employee_advance(text, int, date, text, uuid, text) from public;
revoke all on function public.top_up_employee_advance(uuid, int, date, uuid) from public;
revoke all on function public.settle_employee_advance(uuid, date, uuid) from public;
grant execute on function public.give_employee_advance(text, int, date, text, uuid, text) to authenticated, service_role;
grant execute on function public.top_up_employee_advance(uuid, int, date, uuid) to authenticated, service_role;
grant execute on function public.settle_employee_advance(uuid, date, uuid) to authenticated, service_role;

-- ── 4. Move the old rows ─────────────────────────────────────────────────────
-- Each 'Employee Advance Disbursal' expense → an advance. No spend could ever be linked
-- to one (the FK refused it), so consumed_amount starts at 0. A row marked settled by the
-- old page ('[SETTLED]' in notes) is closed with nothing returned on record — the old page
-- never recorded how much came back, so the asset is cleared rather than invented.
do $$
declare
  r     record;
  v_id  uuid;
  v_txn uuid;
begin
  for r in select * from public.expenses where category = 'Employee Advance Disbursal' loop
    select id into v_txn from public.bank_transactions
     where tenant_id = r.tenant_id and matched_to_type = 'expense' and matched_to_id = r.id
     limit 1;

    insert into public.prepaid_advances
      (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method,
       bank_account_id, notes, created_at, bank_txn_id, closed_at)
    values
      (r.tenant_id, coalesce(nullif(trim(r.vendor_name), ''), 'Staff'), 'Employee advance',
       case when coalesce(r.notes, '') like '[SETTLED]%' then 0 else greatest(0, coalesce(r.amount, 0)) end,
       0, coalesce(r.expense_date, current_date), r.payment_method, r.bank_account_id,
       concat_ws(E'\n', nullif(r.description, 'Employee Expense Advance'), r.notes,
                 'Moved from expenses (' || r.id || ') by R-101'),
       coalesce(r.created_at, now()), v_txn,
       case when coalesce(r.notes, '') like '[SETTLED]%' then coalesce(r.updated_at, now()) end)
    returning id into v_id;

    -- Bank lines matched to the moved rows now point at the advance.
    update public.bank_transactions
       set matched_to_type = 'prepaid', matched_to_id = v_id::text, updated_at = now()
     where tenant_id = r.tenant_id and matched_to_type = 'expense' and matched_to_id = r.id;

    delete from public.expenses where id = r.id;
  end loop;
end $$;
