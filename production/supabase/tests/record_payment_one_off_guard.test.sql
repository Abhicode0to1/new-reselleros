-- Regression test for the one-off (direct-invoice) guard in record_payment (0157).
--
-- Proves:
--   ONE-OFF (quotes.is_one_off = true)  → payment records but NO subscription is created.
--   NORMAL  (quotes.is_one_off = false) → subscription IS still created (regression guard).
--
-- ─── REWRITTEN 22 Aug 2026, and the old version is worth describing ─────────
-- It hardcoded the live tenant and a live customer:
--
--     v_tenant uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';  -- Anutech Digital
--     v_cust   uuid := '53db44e6-6e90-4fec-8871-8d2288393a2a';
--
-- Three things wrong with that, in increasing order of seriousness:
--
--   1. It stopped working. That customer has since been deleted, so the fixture died on
--      `quotes_customer_id_fkey` before reaching a single assertion. Six sibling files in
--      this folder broke the same way on the same day — borrowing live ids makes a test a
--      hostage to whatever the operator did last week.
--   2. It asserted nothing. The old body ended `raise exception 'TESTRESULT >> %'` with the
--      observed values interpolated, so a regression printed a different sentence and still
--      "ran". Expected values sat in a comment at the top of the file for a human to compare
--      by eye. Nobody was comparing.
--   3. It ran record_payment against the REAL tenant's books, creating TESTQ-ONEOFF and
--      TESTQ-NORMAL inside ANUTECH's quote table. Only the closing exception took them back
--      out. Hardcoding a tenant_id is also exactly what AGENTS.md §4 forbids.
--
-- So it now builds its own tenant and customer, asserts, and rolls back — the shape the
-- other passing files in this folder already use.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('0f0f0f0f-0000-4000-8000-000000000001', 'ONE-OFF GUARD TEST', 'oneoff@example.in', '07', 'OOG1');

insert into public.customers (id, tenant_id, name)
  values ('0f0f0f0f-0000-4000-8000-0000000000c1', '0f0f0f0f-0000-4000-8000-000000000001', 'One-off Cust');

do $$
declare
  v_tenant uuid := '0f0f0f0f-0000-4000-8000-000000000001';
  v_cust   uuid := '0f0f0f0f-0000-4000-8000-0000000000c1';
  v_li jsonb := '[{"name":"Google Workspace Business","commitment":"annual_yearly","qty":10,"rate":3240,"cost":2700}]'::jsonb;
  r jsonb;
  n int;
begin
  -- ── ONE-OFF: money lands, no subscription ────────────────────────────────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status, is_one_off)
    values ('TESTQ-ONEOFF', v_tenant, v_cust, 'One-off Cust', 11800, 10000, 18, v_li, 'sent', 'awaiting', true);

  r := public.record_payment('TESTQ-ONEOFF', 11800, 'upi', 'REF-ONEOFF-1', null);

  if (r->>'subscription_created')::boolean is not false then
    raise exception 'FAIL one-off: record_payment reported subscription_created=%, expected false', r->>'subscription_created';
  end if;
  select count(*) into n from public.subscriptions where quote_id = 'TESTQ-ONEOFF';
  if n <> 0 then
    raise exception 'FAIL one-off: % subscription row(s) created for a direct invoice, expected 0', n;
  end if;
  /* The payment itself must still land — that is the half a naive "block it all" fix breaks. */
  select count(*) into n from public.payments where quote_id = 'TESTQ-ONEOFF';
  if n <> 1 then
    raise exception 'FAIL one-off: expected the payment to be recorded (1 row), got %', n;
  end if;

  -- ── NORMAL: the regression guard, and the reason case 1 means anything ────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status, is_one_off)
    values ('TESTQ-NORMAL', v_tenant, v_cust, 'One-off Cust', 11800, 10000, 18, v_li, 'sent', 'awaiting', false);

  r := public.record_payment('TESTQ-NORMAL', 11800, 'upi', 'REF-NORMAL-1', null);

  if (r->>'subscription_created')::boolean is not true then
    raise exception 'FAIL normal: record_payment reported subscription_created=%, expected true', r->>'subscription_created';
  end if;
  select count(*) into n from public.subscriptions where quote_id = 'TESTQ-NORMAL';
  if n <> 1 then
    /* Without this case, "0 subscriptions" above passes just as happily when
       record_payment has stopped creating subscriptions altogether. */
    raise exception 'FAIL normal: expected 1 subscription (so case 1 proves the FLAG, not a dead code path), got %', n;
  end if;

  raise notice 'PASS: one-off records payment with no subscription; normal quote still creates one';
end $$;

-- One visible row: a NOTICE does not survive `supabase db query -f`, and exit 0 with an
-- empty result looks identical to a file that asserted nothing.
select 'PASS' as record_payment_one_off_guard;

rollback;
