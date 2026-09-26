-- Un-reconcile a money-in line AND undo the sale that was raised from it.
--
-- "Invoice banao & reconcile" (reconcile dialog) creates three records from one bank
-- receipt: a one-off quote + GST invoice (create_direct_invoice) and a payment
-- (record_payment, notes 'Reconciled from bank receipt'), then points the line at the
-- payment. Plain un-reconcile (reconcile_bank_txn with nulls) only frees the line — the
-- invoice and receipt stay. Rebooking that line (say, as a project payment) then counts
-- the same money as revenue twice. That is exactly what happened to INV-1111-2026-27-0001.
--
-- unreconcile_bank_receipt(p_txn_id, p_undo_sale):
--   p_undo_sale = false → same as plain un-reconcile.
--   p_undo_sale = true  → also, in the same transaction:
--       • the GST invoice is VOIDED, never deleted — its number stays in the series and
--         the P&L stops counting it (it reads pending / paid / overdue only);
--       • the receipt is deleted (it has no cash behind it once the line is freed);
--       • the quote goes back to no payment and is marked rejected.
--   Refused, changing nothing, when the receipt was not created from this line, when the
--   quote carries other payments, or when the invoice already has a credit / debit note
--   or TDS entry — those need a person, not a button.

create or replace function public.unreconcile_bank_receipt(p_txn_id uuid, p_undo_sale boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_pay     public.payments;
  v_quote   record;
  v_invoice text;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then raise exception 'Bank transaction not found' using errcode = 'no_data_found'; end if;
  if v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if p_undo_sale then
    if v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
      raise exception 'This line is not reconciled to a customer receipt — nothing to undo.';
    end if;
    select * into v_pay from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not found then raise exception 'The receipt this line points to no longer exists.'; end if;
    if v_pay.notes is distinct from 'Reconciled from bank receipt' then
      raise exception 'This receipt was recorded separately, not from this bank line — undo it from Payments instead.';
    end if;

    select id, invoice_id into v_quote from public.quotes where id = v_pay.quote_id for update;
    v_invoice := v_quote.invoice_id;
    if exists (select 1 from public.payments where quote_id = v_pay.quote_id and id <> v_pay.id) then
      raise exception 'This sale has other receipts too — undo it from the invoice, not from here.';
    end if;
    if v_invoice is not null and (
         exists (select 1 from public.credit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.debit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.tds_receivable where invoice_id = v_invoice)
    ) then
      raise exception 'Invoice % has a credit/debit note or TDS entry — handle it from the invoice.', v_invoice;
    end if;
  end if;

  -- Free the line through the one reconcile path, so every other reversal still runs.
  perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

  if p_undo_sale then
    if v_invoice is not null then
      update public.invoices set status = 'void'::invoice_status, paid_date = null
       where id = v_invoice and tenant_id = v_tenant;
    end if;
    delete from public.payments where id = v_pay.id;
    update public.quotes
       set status = 'rejected'::quote_status,
           payment_status = 'none'::payment_status,
           payment_amount = 0,
           payment_method = null, payment_reference = null,
           payment_received_at = null, payment_notes = null
     where id = v_pay.quote_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'unreconciled', true,
    'invoice_voided', case when p_undo_sale then v_invoice end,
    'receipt_removed', case when p_undo_sale then v_pay.id end
  );
end;
$$;

revoke all on function public.unreconcile_bank_receipt(uuid, boolean) from public, anon;
grant execute on function public.unreconcile_bank_receipt(uuid, boolean) to authenticated;

comment on function public.unreconcile_bank_receipt(uuid, boolean) is
  'Un-reconcile a bank line; with p_undo_sale also void the invoice, delete the receipt and reset the quote that "Invoice banao & reconcile" created from it. Refuses when the receipt was not created from the line or the invoice has notes/TDS.';
