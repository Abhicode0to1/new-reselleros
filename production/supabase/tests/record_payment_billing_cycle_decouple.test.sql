-- Regression test: after the billing-cycle decouple (migration 0161), the subscription a
-- payment creates is shaped by the LINE'S PRICE TIER (`commitment`), never by the
-- quote-level `billing_cycle` frequency. The two are independent and must stay so.
--
-- ─── REWRITTEN 22 Aug 2026, for two separate reasons ────────────────────────
--
-- 1. It borrowed the live tenant and a live customer (`53db44e6…`, since deleted), so it
--    inserted TESTQ-BC-ANNUAL and TESTQ-BC-FLEX into ANUTECH's books and ran record_payment
--    there, held back only by the closing exception. It also asserted nothing — the results
--    went into a message with the expected values beside them for a human to read.
--    See AGENTS.md L11.
--
-- 2. Its second case was made STALE the same morning. It asserted "MONTHLY-flex price tier →
--    NO subscription (unchanged)", which was true until 85a5d67 taught record_payment to
--    create monthly subscriptions. Nobody noticed, because this folder is in neither CI nor
--    the Stop hook. Same story as renewal_and_subscription_creation.
--
-- The decouple itself is unaffected by that change and is still the point of the file:
-- billing_cycle says how OFTEN the customer is billed, `commitment` says what they committed
-- to. Every number below was measured against the live DB before being asserted.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c0de0004-0000-4000-8000-000000000001', 'BILLING CYCLE DECOUPLE TEST', 'bc@example.in', '07', 'BCT1');

insert into public.customers (id, tenant_id, name, country, state_code, state)
  values ('c0de0004-0000-4000-8000-0000000000c1', 'c0de0004-0000-4000-8000-000000000001',
          'BC Cust', 'India', '07', 'Delhi');

do $$
declare
  v_t uuid := 'c0de0004-0000-4000-8000-000000000001';
  v_c uuid := 'c0de0004-0000-4000-8000-0000000000c1';
  v_annual jsonb := '[{"name":"GW Business","commitment":"annual_yearly","qty":10,"rate":3240,"cost":2700}]'::jsonb;
  v_flex   jsonb := '[{"name":"GW Business","commitment":"monthly","qty":10,"rate":3240,"cost":2700}]'::jsonb;
  r jsonb; n int; v_term int; v_mrr int;
begin
  -- ── ANNUAL price tier, QUARTERLY billing cycle ────────────────────────────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status, is_one_off, billing_cycle)
    values ('TESTQ-BC-ANNUAL', v_t, v_c, 'BC Cust', 11800, 10000, 18, v_annual, 'sent', 'awaiting', false, 'quarterly');

  r := public.record_payment('TESTQ-BC-ANNUAL', 11800, 'upi', 'REF-BC-ANNUAL', null);

  if (r->>'subscription_created')::boolean is not true then
    raise exception 'FAIL annual: subscription_created=%, expected true', r->>'subscription_created';
  end if;
  select count(*), max(term_months), max(mrr) into n, v_term, v_mrr
    from public.subscriptions where quote_id = 'TESTQ-BC-ANNUAL';
  if n <> 1 then raise exception 'FAIL annual: expected 1 subscription, got %', n; end if;

  /* THE DECOUPLE, in one assertion. The quote says billing_cycle='quarterly'. If anything
     ever wires the term from the billing frequency, this becomes 3 and the customer's annual
     commitment silently turns into a quarterly one — which also moves their renewal date nine
     months earlier and puts the reminder ladder on the wrong clock. */
  if v_term <> 12 then
    raise exception 'FAIL annual: term_months %, expected 12 — a quarterly BILLING cycle must not shorten an annual COMMITMENT', v_term;
  end if;
  /* 3240 per seat per year x 10 seats = 32,400 a year = 2,700 a month. */
  if v_mrr <> 2700 then raise exception 'FAIL annual: mrr %, expected 2700', v_mrr; end if;

  -- ── MONTHLY price tier ────────────────────────────────────────────────────
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                             line_items, status, payment_status, is_one_off, billing_cycle)
    values ('TESTQ-BC-FLEX', v_t, v_c, 'BC Cust', 11800, 10000, 18, v_flex, 'sent', 'awaiting', false, 'monthly');

  r := public.record_payment('TESTQ-BC-FLEX', 11800, 'upi', 'REF-BC-FLEX', null);

  if (r->>'subscription_created')::boolean is not true then
    /* Was `false` until 85a5d67 on 22 Aug 2026. A monthly plan that created no subscription
       was a paying customer the renewal ladder could never see. */
    raise exception 'FAIL flex: subscription_created=%, expected true since 85a5d67', r->>'subscription_created';
  end if;
  select count(*), max(term_months), max(mrr) into n, v_term, v_mrr
    from public.subscriptions where quote_id = 'TESTQ-BC-FLEX';
  if n <> 1 then raise exception 'FAIL flex: expected 1 subscription, got %', n; end if;
  if v_term <> 1 then raise exception 'FAIL flex: term_months %, expected 1', v_term; end if;
  /* The FULL month — 3240 x 10 — not a twelfth of it. A twelfth here would be 2,700, which
     is exactly the annual figure above, so getting this wrong makes the two cases agree and
     the bug invisible. */
  if v_mrr <> 32400 then
    raise exception 'FAIL flex: mrr %, expected 32400 (the whole month; a twelfth would be 2700)', v_mrr;
  end if;

  raise notice 'PASS: price tier shapes the subscription, billing_cycle does not';
end $$;

select 'PASS' as record_payment_billing_cycle_decouple;

rollback;
