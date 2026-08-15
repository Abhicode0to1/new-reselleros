-- 0109: delete a PROJECT milestone invoice + everything tied to it, atomically.
--
-- When the operator deletes a project invoice we must, in one transaction:
--   1. delete the project_payments recorded against that milestone,
--   2. un-reconcile any bank line matched to those payments (so the imported
--      credit becomes "unmatched" again, not pointing at a deleted payment),
--   3. reset the milestone (invoice_id → null, status → 'pending'),
--   4. delete the invoice row,
--   5. roll the invoice number back by one IF this was the last-issued number
--      (keeps the GST series gap-free when undoing the most recent invoice).
--
-- Only works for PROJECT invoices (an invoice referenced by a project_milestone).
-- Subscription invoices (quote-generated) are NOT handled here.

create or replace function public.delete_project_invoice(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_inv     public.invoices;
  v_ms_ids  uuid[];
  v_num     integer;
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

  -- 2) un-reconcile bank lines matched to this milestone's payments
  update public.bank_transactions b
     set matched_to_type = null, matched_to_id = null, matched_at = null, match_confidence = null
   where b.tenant_id = v_inv.tenant_id
     and b.matched_to_type = 'project'
     and b.matched_to_id in (
       select p.id::text from public.project_payments p where p.milestone_id = any (v_ms_ids)
     );

  -- 1) delete the payments recorded against these milestones
  delete from public.project_payments where milestone_id = any (v_ms_ids);

  -- 3) reset the milestones to un-billed / unpaid
  update public.project_milestones
     set invoice_id = null, status = 'pending'
   where id = any (v_ms_ids);

  -- 4) delete the invoice
  delete from public.invoices where id = p_invoice_id;

  -- 5) roll the number back if this was the latest one issued (gap-free undo)
  v_num := nullif(regexp_replace(p_invoice_id, '^.*-([0-9]+)$', '\1'), p_invoice_id)::integer;
  if v_num is not null then
    update public.document_series
       set last_number = greatest(last_number - 1, 0)
     where tenant_id = v_inv.tenant_id and doc_type = 'invoice' and last_number = v_num;
  end if;
end;
$$;
grant execute on function public.delete_project_invoice(text) to authenticated;
