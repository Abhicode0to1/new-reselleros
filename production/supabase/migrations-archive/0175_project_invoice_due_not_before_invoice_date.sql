-- 0175_project_invoice_due_not_before_invoice_date.sql
-- ============================================================================
-- raise_project_milestone_invoice — clamp the invoice due date so it can NEVER
-- fall before the invoice date.
--
-- A milestone's `due_date` is free-form (set when scheduling the project). If it
-- was set to a past date, `coalesce(v_ms.due_date, v_inv_date)` stamped the
-- invoice with due_date < invoice_date — e.g. "Invoice 23 Jul · Due 8 Jul",
-- which is nonsensical and reads as instantly-overdue. The UI now blocks past
-- milestone due dates, but this is the money-spine backstop: at raise time the
-- due date is floored to the invoice date via
--   greatest(coalesce(milestone.due_date, inv_date), inv_date)
-- so no path (legacy data, imports, re-raise) can produce due < invoice.
--
-- Rolled-back test (0175): milestone with a past due_date → invoice due_date ==
-- invoice_date (clamped); milestone with a future due_date → kept as-is.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.raise_project_milestone_invoice(p_milestone_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_proj     record;
  v_id       text;
  v_paid     integer;
  v_full     boolean;
  v_pay_date date;
  v_inv_date date;
  v_rate     integer;
  v_taxable  integer;
  v_tax      integer;
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

  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(v_ms.total_amount * 100.0 / (100 + v_rate));
  v_tax     := v_ms.total_amount - v_taxable;

  v_id := public.next_document_number('invoice', v_ms.tenant_id);
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, greatest(coalesce(v_ms.due_date, v_inv_date), v_inv_date),
     case when v_full then v_inv_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false));

  update public.project_milestones
     set invoice_id = v_id,
         status = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;
