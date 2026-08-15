-- 0095: Edit / delete a PENDING expense claim.
--
-- Wrong entries happen. A pending claim hasn't touched the books yet (it only
-- becomes an expense + reduces the advance on approval), so editing or deleting
-- one is a safe metadata change — no money to reverse. Approved claims are NOT
-- editable here (they're booked); fix those via the expense/advance tools.
--
-- Both sides can fix a pending claim:
--   • Owner (authenticated, current_tenant_id): edit_expense_claim / delete_expense_claim
--   • Employee (public link + PIN): edit_claim_public / delete_claim_public
-- Edit re-checks the new amount against what's still claimable (principal −
-- approved repayments − other pending claims).

-- ── Owner: edit a pending claim ─────────────────────────────────────────────
create or replace function public.edit_expense_claim(
  p_claim_id  uuid,
  p_amount    integer,
  p_category  text,
  p_purpose   text,
  p_spent_on  date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_claim      public.expense_claims;
  v_loan       public.employee_loans;
  v_paid       integer;
  v_pending    integer;
  v_available  integer;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if trim(coalesce(p_category, '')) = '' then raise exception 'Please choose a category'; end if;

  select * into v_claim from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'Only pending claims can be edited'; end if;

  select * into v_loan from public.employee_loans where id = v_claim.loan_id and tenant_id = v_tenant;
  if not found then raise exception 'The advance for this claim no longer exists'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending' and id <> p_claim_id;
  v_available := v_loan.principal - v_paid - v_pending;
  if p_amount > v_available then
    raise exception 'Amount (%) is more than what is still claimable (%)', p_amount, v_available;
  end if;

  update public.expense_claims
     set amount = p_amount, category = trim(p_category),
         purpose = nullif(trim(coalesce(p_purpose, '')), ''), spent_on = coalesce(p_spent_on, spent_on)
   where id = p_claim_id and tenant_id = v_tenant;
end;
$$;

grant execute on function public.edit_expense_claim(uuid, integer, text, text, date) to authenticated;

-- ── Owner: delete a pending claim ───────────────────────────────────────────
create or replace function public.delete_expense_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  select status into v_status from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_status <> 'pending' then raise exception 'Only pending claims can be deleted'; end if;
  delete from public.expense_claims where id = p_claim_id and tenant_id = v_tenant;
end;
$$;

grant execute on function public.delete_expense_claim(uuid) to authenticated;

-- ── Employee (public + PIN): edit their own pending claim ───────────────────
create or replace function public.edit_claim_public(
  p_tenant_id   uuid,
  p_employee_id uuid,
  p_pin         text,
  p_claim_id    uuid,
  p_amount      integer,
  p_category    text,
  p_purpose     text,
  p_spent_on    date
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_emp        public.employees;
  v_claim      public.expense_claims;
  v_loan       public.employee_loans;
  v_paid       integer;
  v_pending    integer;
  v_available  integer;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if trim(coalesce(p_category, '')) = '' then raise exception 'Please choose a category'; end if;

  select * into v_emp from public.employees where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if p_pin is null or v_emp.pin_hash is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_claim from public.expense_claims
    where id = p_claim_id and tenant_id = p_tenant_id and employee_id = p_employee_id;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim can no longer be changed'; end if;

  select * into v_loan from public.employee_loans where id = v_claim.loan_id;
  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending' and id <> p_claim_id;
  v_available := v_loan.principal - v_paid - v_pending;
  if p_amount > v_available then
    raise exception 'Amount (%) is more than your remaining advance (%)', p_amount, v_available;
  end if;

  update public.expense_claims
     set amount = p_amount, category = trim(p_category),
         purpose = nullif(trim(coalesce(p_purpose, '')), ''), spent_on = coalesce(p_spent_on, spent_on)
   where id = p_claim_id;
end;
$$;

grant execute on function public.edit_claim_public(uuid, uuid, text, uuid, integer, text, text, date) to anon, authenticated;

-- ── Employee (public + PIN): delete their own pending claim ─────────────────
create or replace function public.delete_claim_public(
  p_tenant_id   uuid,
  p_employee_id uuid,
  p_pin         text,
  p_claim_id    uuid
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_emp   public.employees;
  v_claim public.expense_claims;
begin
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if p_pin is null or v_emp.pin_hash is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_claim from public.expense_claims
    where id = p_claim_id and tenant_id = p_tenant_id and employee_id = p_employee_id;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim can no longer be removed'; end if;

  delete from public.expense_claims where id = p_claim_id;
end;
$$;

grant execute on function public.delete_claim_public(uuid, uuid, text, uuid) to anon, authenticated;
