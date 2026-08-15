-- 0118 — deleting an invoice must NOT reuse its GST serial (MONEY-3).
--
-- Both delete RPCs ended by rolling the tenant's invoice series back by one when
-- the deleted invoice was the latest — so the NEXT invoice reused that number.
-- Two different supplies then share one invoice number, which CGST Rule 46
-- prohibits (an ITC/audit hazard). The lawful treatment of a cancelled invoice
-- is that its number stays consumed (a cancelled/gap entry), never reissued.
--
-- Fix: drop the serial-rollback tail from both functions. Delete still works for
-- correcting a mistake (payments reversed, milestones freed, invoice removed) —
-- but the number is retired, not reused. (A proper GST Credit Note flow for
-- cancelling issued invoices is a separate, larger follow-up.)

create or replace function public.delete_project_invoice(p_invoice_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_inv     public.invoices;
  v_ms_ids  uuid[];
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  if v_tenant is not null and v_inv.tenant_id is distinct from v_tenant then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  select array_agg(id) into v_ms_ids
    from public.project_milestones
   where invoice_id = p_invoice_id and tenant_id = v_inv.tenant_id;

  if v_ms_ids is null then
    raise exception 'Not a project invoice (nothing references it) — cannot delete here'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.bank_transactions b
     set matched_to_type = null, matched_to_id = null, matched_at = null, match_confidence = null
   where b.tenant_id = v_inv.tenant_id
     and b.matched_to_type = 'project'
     and b.matched_to_id in (
       select p.id::text from public.project_payments p where p.milestone_id = any (v_ms_ids)
     );

  delete from public.project_payments where milestone_id = any (v_ms_ids);

  update public.project_milestones
     set invoice_id = null, status = 'pending'
   where id = any (v_ms_ids);

  delete from public.invoices where id = p_invoice_id;
  -- NOTE: the invoice's document-series number is intentionally NOT rolled back —
  -- reusing a GST serial for a different supply is prohibited (MONEY-3).
end;
$function$;

create or replace function public.delete_subscription_invoice(p_invoice_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    public.invoices;
  v_paid   integer;
  v_status payment_status;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  if v_tenant is not null and v_inv.tenant_id is distinct from v_tenant then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.project_milestones where invoice_id = p_invoice_id) then
    raise exception 'This is a project invoice — delete it from the project flow'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_inv.quote_id is not null then
    select coalesce(sum(amount), 0) into v_paid
      from public.payments
     where quote_id = v_inv.quote_id and status = 'received';

    v_status := (case
      when v_paid >= coalesce(v_inv.amount, 0) and v_paid > 0 then 'received'
      when v_paid > 0                                         then 'partial'
      else 'none'
    end)::payment_status;

    update public.quotes
       set invoice_id = null, payment_status = v_status
     where id = v_inv.quote_id and tenant_id = v_inv.tenant_id;
  end if;

  delete from public.invoices where id = p_invoice_id;
  -- NOTE: document-series number intentionally NOT rolled back (see MONEY-3).
end;
$function$;
