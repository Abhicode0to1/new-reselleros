-- 0133: make reimbursements employee-aware.
--
-- Extends the generic reimbursements tracker (0130) so an employee's own-money
-- spend on company work can be recorded against THEM (a proper employee
-- reimbursement), with an optional receipt. person_name stays for non-employees
-- (a director, a friend's card, etc.), so both cases live in one place.

alter table public.reimbursements
  add column if not exists employee_id  uuid references public.employees(id) on delete set null,
  add column if not exists receipt_path text;

create index if not exists reimbursements_employee_idx
  on public.reimbursements(employee_id) where employee_id is not null;

-- Recreate add_reimbursement with two new OPTIONAL params (employee link +
-- receipt path). Drop the old 7-arg signature first to avoid overload ambiguity.
drop function if exists public.add_reimbursement(text, text, text, integer, integer, date, text);

create or replace function public.add_reimbursement(
  p_person text, p_purpose text, p_category text, p_amount integer,
  p_gst integer, p_incurred_on date, p_paid_via text,
  p_employee_id uuid default null, p_receipt_path text default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'Other');
  v_via    text := nullif(trim(coalesce(p_paid_via, '')), '');
  v_exp_id text;
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if coalesce(trim(p_person), '') = '' then raise exception 'Who paid? — person name is required'; end if;
  if coalesce(trim(p_purpose), '') = '' then raise exception 'What was it for? — purpose is required'; end if;

  -- Guard the employee link stays inside the tenant.
  if p_employee_id is not null then
    perform 1 from public.employees where id = p_employee_id and tenant_id = v_tenant;
    if not found then raise exception 'Employee not found'; end if;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, v_cat, trim(p_person), coalesce(p_incurred_on, current_date), p_amount, greatest(coalesce(p_gst, 0), 0), 'reimbursement',
          'Reimbursement · ' || p_purpose || ' · paid by ' || trim(p_person) || coalesce(' (' || v_via || ')', ''));

  insert into public.reimbursements (tenant_id, person_name, purpose, category, amount, gst_paid, incurred_on, paid_via, employee_id, receipt_path, expense_id, created_by)
  values (v_tenant, trim(p_person), trim(p_purpose), v_cat, p_amount, greatest(coalesce(p_gst, 0), 0), coalesce(p_incurred_on, current_date), v_via,
          p_employee_id, nullif(trim(coalesce(p_receipt_path, '')), ''), v_exp_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$;

grant execute on function public.add_reimbursement(text, text, text, integer, integer, date, text, uuid, text) to authenticated;
