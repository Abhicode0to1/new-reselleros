-- ============================================================================
-- 0173 — reopen_quote: revert an accidentally-accepted quote back to 'sent'.
--
-- "Mark accepted" (accept_quote) advances a quote to 'accepted', converts the
-- lead → customer and marks the lead 'won'. There was no way to undo an
-- accidental accept. reopen_quote reverts ONLY the quote status (→ 'sent',
-- payment_status → 'none'); the customer record + lead conversion are left as-is
-- (option A — the operator can archive/delete the customer separately if it was
-- a mistake).
--
-- Money-safe: refuses if any money has moved — an invoice was raised, the
-- payment_status is received/partial/invoiced, or a received payment row exists.
-- Rolled-back test (0173): accepted+awaiting → sent/none (PASS); accepted+received
-- → blocked (PASS).
-- ============================================================================
create or replace function public.reopen_quote(p_quote_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_quote record;
begin
  select id, tenant_id, status, payment_status, invoice_id
    into v_quote
    from public.quotes where id = p_quote_id
    for update;
  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if public.current_tenant_id() is not null
     and v_quote.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Only an accepted quote can be reopened (this one is %)', v_quote.status
      using errcode = 'check_violation';
  end if;

  -- Money guard — never reopen once a payment or invoice exists.
  if v_quote.invoice_id is not null
     or v_quote.payment_status in ('received', 'partial', 'invoiced')
     or exists (select 1 from public.payments p where p.quote_id = p_quote_id and p.status = 'received') then
    raise exception 'Can''t reopen — this quote has a payment or invoice. Reverse those first.'
      using errcode = 'check_violation';
  end if;

  update public.quotes
     set status = 'sent', payment_status = 'none'::payment_status
   where id = p_quote_id;
end;
$function$;

grant execute on function public.reopen_quote(text) to authenticated;
