-- 0147: money-hardening — re-add two defensive guards to record_payment that
-- were lost in a later CREATE OR REPLACE (audit #3 zero-amount, #5 seats=0).
--
--   #3  A quote with amount <= 0 (empty / hand-built) + any payment used to flip
--       to "fully paid" (v_total_received >= v_expected(0)) and spawn a ₹0
--       subscription. Guard: reject a payment against a zero-value quote — placed
--       AFTER the idempotent-replay check so replays of legit payments still return.
--   #5  A non-bulk annual line with qty 0/missing created a seats=0 subscription
--       + bogus MRR/PO. Guard: reject zero seats.
--
-- Done as a surgical injection on the LIVE body (read via pg_get_functiondef +
-- string-replace at unique anchors) so we never hand-retype the 200-line RPC.
-- A safety check aborts if either anchor didn't match (no silent no-op).

do $mig$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('public.record_payment(text,integer,text,text,text)'::regprocedure);

  -- #3 — inject right after v_expected + v_domain are set (post idempotent check)
  v_src := replace(
    v_src,
    $find1$:= v_quote.domain;$find1$,
    $repl1$:= v_quote.domain;
  if v_expected <= 0 then raise exception 'quote % has no amount - cannot record a payment against a zero-value quote', p_quote_id using errcode = 'check_violation'; end if;$repl1$
  );

  -- #5 — inject in the non-bulk annual branch (the ", 0)" default is unique to it)
  v_src := replace(
    v_src,
    $find2$v_seats := coalesce((v_first_line->>'qty')::int, 0);$find2$,
    $repl2$v_seats := coalesce((v_first_line->>'qty')::int, 0);
          if v_seats <= 0 then raise exception 'annual line has zero seats (quote %)', p_quote_id using errcode = 'check_violation'; end if;$repl2$
  );

  -- safety: abort if either guard failed to inject (anchor drift)
  if position('no amount - cannot record' in v_src) = 0 then
    raise exception '0147 aborted: zero-amount guard anchor did not match record_payment body';
  end if;
  if position('annual line has zero seats' in v_src) = 0 then
    raise exception '0147 aborted: seats=0 guard anchor did not match record_payment body';
  end if;

  execute v_src;
end $mig$;
