-- 0150_record_payment_with_tds_atomic.sql
-- ---------------------------------------------------------------------------
-- Audit bug #22: the TDS receivable was inserted client-side, AFTER record_payment
-- had already settled the quote (bank + TDS) — a best-effort insert that swallowed
-- errors. If it failed, the quote showed fully-paid while the government-owed TDS
-- receivable silently vanished (a real loss of the reseller's money at ITR time).
--
-- Fix: a thin wrapper that calls the canonical record_payment RPC and inserts the
-- TDS receivable in the SAME transaction. record_payment itself is UNTOUCHED
-- (byte-identical) — zero blast radius for the 99% of payments with no TDS.
-- If the TDS insert fails, the exception rolls the payment back too: either both
-- commit or neither does. On an idempotent replay (same reference) the TDS insert
-- is skipped, mirroring the client's prior `isReplay` guard.
-- ---------------------------------------------------------------------------

create or replace function public.record_payment_with_tds(
  p_quote_id     text,
  p_amount       integer,
  p_method       text,
  p_reference    text,
  p_notes        text    default null,
  p_tds_amount   integer default 0,
  p_tds_gross    integer default 0,     -- pre-GST gross the TDS was computed on
  p_tds_net_paid integer default 0,     -- bank amount actually received (post-TDS)
  p_tds_section  text    default null,
  p_tds_rate_pct numeric default null,
  p_customer_tan text    default null,
  p_invoice_id   text    default null,
  p_fiscal_year  text    default null
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_result    jsonb;
  v_replay    boolean;
  v_pay_id    uuid;
  v_tenant    uuid;
  v_cust      uuid;
  v_cust_name text;
  v_tds_saved boolean := false;
begin
  -- Delegate to the canonical money RPC. It runs inside THIS transaction, so a
  -- later failure below rolls back everything it did.
  v_result := public.record_payment(p_quote_id, p_amount, p_method, p_reference, p_notes);

  v_replay := coalesce((v_result->>'already_recorded')::boolean, false)
           or coalesce((v_result->>'idempotent_replay')::boolean, false);
  v_pay_id := nullif(v_result->>'payment_id', '')::uuid;

  if not v_replay and coalesce(p_tds_amount, 0) > 0 then
    select tenant_id, customer_name into v_tenant, v_cust_name
      from public.quotes where id = p_quote_id;
    -- Prefer the customer record_payment resolved/created; fall back to none.
    v_cust := nullif(v_result->>'customer_id', '')::uuid;

    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name,
      customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid,
      fiscal_year, payment_received_date, status, notes
    ) values (
      'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      v_tenant, p_invoice_id, v_pay_id, v_cust, coalesce(v_cust_name, ''),
      nullif(trim(p_customer_tan), ''), coalesce(p_tds_section, '194J'), p_tds_rate_pct,
      p_tds_gross, p_tds_amount, p_tds_net_paid,
      coalesce(p_fiscal_year, public.indian_fiscal_year(current_date)),
      current_date, 'pending_cert',
      'Auto-created atomically with payment ' || coalesce(v_pay_id::text, '?') || ' on quote ' || p_quote_id
    );
    v_tds_saved := true;
  end if;

  -- Return record_payment's result untouched (so every existing client field
  -- still works), plus a flag confirming the TDS row committed with the payment.
  return v_result || jsonb_build_object('tds_saved', v_tds_saved);
end;
$function$;

grant execute on function public.record_payment_with_tds(text, integer, text, text, text, integer, integer, integer, text, numeric, text, text, text)
  to authenticated, service_role;
