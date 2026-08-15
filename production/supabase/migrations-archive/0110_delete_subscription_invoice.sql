-- 0110: delete a SUBSCRIPTION (quote-generated) invoice — SAFE reversal.
--
-- Un-does ONLY the invoice-generation step:
--   • delete the invoice row,
--   • reset the source quote (invoice_id → null, payment_status recomputed from
--     its actual received payments: received / partial / none),
--   • roll the invoice number back if this was the last one issued (gap-free).
--
-- Deliberately does NOT touch payments, subscriptions, outstanding or renewals
-- — that received money + active service is real; deleting the GST document
-- just re-opens the quote so a fresh invoice can be generated. (A full
-- payment/subscription reversal is a separate, tested operation.)
--
-- Refuses PROJECT invoices (use delete_project_invoice for those).

create or replace function public.delete_subscription_invoice(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    public.invoices;
  v_paid   integer;
  v_status payment_status;
  v_num    integer;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  if v_tenant is not null and v_inv.tenant_id is distinct from v_tenant then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  -- Guard: project invoices go through delete_project_invoice.
  if exists (select 1 from public.project_milestones where invoice_id = p_invoice_id) then
    raise exception 'This is a project invoice — delete it from the project flow'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Reset the source quote so it can be re-invoiced.
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

  -- Roll the number back if this was the latest issued (gap-free undo).
  v_num := nullif(regexp_replace(p_invoice_id, '^.*-([0-9]+)$', '\1'), p_invoice_id)::integer;
  if v_num is not null then
    update public.document_series
       set last_number = greatest(last_number - 1, 0)
     where tenant_id = v_inv.tenant_id and doc_type = 'invoice' and last_number = v_num;
  end if;
end;
$$;
grant execute on function public.delete_subscription_invoice(text) to authenticated;
