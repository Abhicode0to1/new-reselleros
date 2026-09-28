-- ============================================================================
-- A milestone invoice is dated the day it is ISSUED — 26 Sep 2026.
-- Cross-team request R-003, raised by Pardeep (Accounting & Finance) on 25 Sep 2026.
--
-- WHY
--   `raise_project_milestone_invoice` dated the invoice from the PAYMENT:
--
--     v_inv_date := case when v_full and v_pay_date is not null
--                        then v_pay_date else current_date end;
--
--   The number, though, comes from `next_document_number` at the moment the function
--   runs. So the two disagree the instant a milestone is invoiced out of order.
--   Measured on Pardeep's machine on 25 Sep 2026, both raised the same day:
--
--     INV-1111-2026-27-0002   dated 7 Aug 2026
--     INV-1111-2026-27-0003   dated 8 Jul 2026     <- higher number, EARLIER date
--
--   CGST Rule 46 wants a consecutive series, and GSTR-1 lists invoices by date. A
--   higher number carrying an earlier date is what a back-dated or inserted invoice
--   looks like to an auditor, and there is no way to explain it after the fact.
--
-- WHAT THIS DOES — option 1 of the two Pardeep offered
--   The invoice is dated `current_date`, always. That is the truth: the document came
--   into existence today, whatever the money did earlier.
--
--   `paid_date` keeps the REAL receipt date. That is the point of having both columns,
--   and it is the half that would have been lost by simply forcing both to today —
--   the ledger would then say the money arrived when the paperwork did.
--
--   An advance that arrived before its invoice is not an anomaly to hide: CGST
--   31(3)(d) covers it with a receipt voucher, which `record_payment` already issues.
--
--   `due_date` still cannot land before the invoice date (unchanged `greatest(...)`).
--
-- WHY NOT OPTION 2 (refuse a date earlier than the latest in the series)
--   It keeps back-dating and adds a guard that fires while somebody is trying to bill
--   a customer, with no way forward except picking a different date — a dead end in
--   the middle of the money path (§24/§7). Option 1 removes the question instead.
--
-- Everything else in the function is byte-identical to the version this replaces.
-- ============================================================================

begin;

create or replace function public.raise_project_milestone_invoice(p_milestone_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  v_full := v_paid >= v_ms.total_amount;

  -- R-003. Was: the first payment's date when fully paid. The number is allocated
  -- below, from today's series, so any earlier date puts the two out of step.
  v_inv_date := current_date;

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
     -- The money's own date, not the document's. An advance really did arrive then.
     case when v_full then v_pay_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false));

  update public.project_milestones
     set invoice_id = v_id,
         status     = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;

commit;
