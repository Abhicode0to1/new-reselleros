-- 0058_generate_invoice_rpc.sql
-- Atomic, tenant-safe invoice generation (audit bugs #8 race, #9 orphan).
--
-- WHY: invoice generation used to be a 6-step client-side chain in
-- useGenerateInvoice() (lib/queries/invoices.ts):
--   1. read quote (refuse if invoice_id set)
--   2. compute_advance_adjustment()
--   3. next_document_number('invoice')
--   4. derive status
--   5. insert invoices row
--   6. update quotes.payment_status='invoiced', invoice_id
-- Two concurrent clicks could both pass step 1 before either wrote, each
-- allocating a number (#8 race — the invoices_quote_unique index blocked the
-- 2nd INSERT but left a wasted number + failed txn). And an insert that
-- succeeded while the step-6 update failed left an invoice with the quote
-- NOT marked invoiced (#9 orphan).
--
-- FIX: one SECURITY DEFINER function, one transaction.
--   * SELECT ... FOR UPDATE on the quote row serialises concurrent callers.
--   * INSERT invoice + UPDATE quote happen atomically — no orphan.
--   * invoices_quote_unique (migration 0053) remains as the final backstop.
--
-- SECURITY: the old client path relied on RLS (a user could only load their
-- own tenant's quotes). SECURITY DEFINER bypasses RLS, so we add an explicit
-- tenant guard: an authenticated caller may only invoice a quote in their own
-- tenant. Service-role / cron contexts (current_tenant_id() IS NULL) are
-- trusted and bypass the guard, exactly as they bypass RLS today.
--
-- Behaviour is otherwise an exact port of the client logic (same status rule,
-- same 30-day due date, same razorpay_id mapping, same frozen advance snapshot).

create or replace function public.generate_invoice(p_quote_id text)
returns table(invoice_id text, net_payable integer, total_advances integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote   record;
  v_adv     jsonb;
  v_total   integer;
  v_first   timestamptz;
  v_id      text;
  v_gross   integer;
  v_net     integer;
  v_status  invoice_status;
  v_today   date := current_date;
begin
  -- Lock the quote row → serialises concurrent invoice generation (#8).
  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;

  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  -- Tenant guard — authenticated callers are locked to their own tenant.
  -- Service-role / cron (current_tenant_id() IS NULL) is trusted and skips it.
  if public.current_tenant_id() is not null
     and v_quote.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotency — one quote, one invoice.
  if v_quote.invoice_id is not null then
    raise exception 'Invoice % already exists for quote %', v_quote.invoice_id, p_quote_id
      using errcode = 'unique_violation';
  end if;

  -- Frozen advance-adjustment snapshot (CGST Rule 53).
  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_gross  := coalesce(v_quote.amount, 0);
  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  -- Sequential, per-tenant, per-FY invoice number (atomic UPSERT row-lock).
  v_id := public.next_document_number('invoice', v_quote.tenant_id);
  if v_id is null then
    raise exception 'Could not allocate invoice number for quote %', p_quote_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date, razorpay_id,
    adjusted_advances, net_payable, first_advance_at, quote_id
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    v_today, v_today + 30, case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id
  );

  -- Same transaction → quote can never be left un-invoiced (#9).
  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  return query select v_id, v_net, v_total;
end;
$$;

grant execute on function public.generate_invoice(text) to authenticated, service_role;
