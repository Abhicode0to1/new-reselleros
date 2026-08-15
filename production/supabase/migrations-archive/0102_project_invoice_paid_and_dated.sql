-- 0102: raise_project_milestone_invoice — handle already-paid milestones.
--
-- The UI lets an operator record a milestone payment before raising its Tax
-- Invoice (e.g. an advance that already hit the bank). The original RPC always
-- dated the invoice today and created it 'pending' — wrong for a milestone that
-- is already paid.
--
-- Now: if the milestone is already fully paid, the invoice is dated to the
-- (earliest) payment date and created 'paid' (paid_date set, net_payable 0),
-- and the milestone stays 'paid'. Otherwise: today's date, 'pending', as before.

create or replace function public.raise_project_milestone_invoice(p_milestone_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_proj     record;
  v_id       text;
  v_paid     integer;
  v_full     boolean;
  v_pay_date date;
  v_inv_date date;
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_tenant is not null and v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_ms.invoice_id is not null then
    raise exception 'Invoice % already raised for this milestone', v_ms.invoice_id
      using errcode = 'unique_violation';
  end if;

  select * into v_proj from public.project_sales where id = v_ms.project_id;

  select coalesce(sum(amount), 0), min(received_at)
    into v_paid, v_pay_date
    from public.project_payments where milestone_id = p_milestone_id;
  v_full     := v_paid >= v_ms.total_amount;
  v_inv_date := case when v_full and v_pay_date is not null then v_pay_date else current_date end;

  v_id := public.next_document_number('invoice', v_ms.tenant_id);
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, coalesce(v_ms.due_date, v_inv_date + 15),
     case when v_full then v_inv_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null);

  update public.project_milestones
     set invoice_id = v_id,
         status = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$$;
grant execute on function public.raise_project_milestone_invoice(uuid) to authenticated;
