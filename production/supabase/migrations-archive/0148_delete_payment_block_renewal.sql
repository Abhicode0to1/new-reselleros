-- 0148: money-hardening (audit #6) — block deleting a RENEWAL/EXTENSION payment.
--
-- Bug: delete_payment reverses subs/POs via `quote_id = payment.quote_id`. A
-- renewal sub's quote_id is the ORIGINAL sale quote (not the renewal quote), and
-- once rolled forward the renewal_quote_id link is nulled. So deleting a fully-
-- paid renewal payment removed the money row but left the subscription extended
-- a year FOR FREE, with no way to re-detect it.
--
-- Fix: quotes.is_renewal is set (persistently) on every renewal + extension quote
-- at creation and survives roll-forward. Block deletion of any payment against a
-- renewal/extension quote with a clear message (safe — the audit's recommended
-- option; auto-rollback of renewal dates is a larger future change).
--
-- Surgical injection on the live delete_payment body (read + string-replace at
-- unique anchors), with a safety abort if an anchor didn't match.

do $mig$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('public.delete_payment(uuid)'::regprocedure);

  -- add is_renewal to the quote SELECT
  v_src := replace(
    v_src,
    $find1$id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, status$find1$,
    $repl1$id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, status, is_renewal$repl1$
  );

  -- block renewal/extension-payment deletion right after the quote is loaded
  v_src := replace(
    v_src,
    $find2$into v_quote from public.quotes where id = v_pay.quote_id;$find2$,
    $repl2$into v_quote from public.quotes where id = v_pay.quote_id;

  if coalesce(v_quote.is_renewal, false) then
    raise exception 'This is a renewal/extension payment - deleting it will not roll the subscription back. Cancel the renewal from the subscription instead, or contact support.'
      using errcode = 'invalid_parameter_value';
  end if;$repl2$
  );

  if position('renewal/extension payment - deleting' in v_src) = 0 then
    raise exception '0148 aborted: renewal-block anchor did not match delete_payment body';
  end if;

  execute v_src;
end $mig$;
