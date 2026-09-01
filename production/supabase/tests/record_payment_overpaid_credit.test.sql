-- Regression test: overpayment → customer credit INSIDE record_payment
-- (migration 20260901110000, audit A5 — 1 Sep 2026)
--
-- Pehle ye insert client me tha (record-payment-dialog.tsx), RPC-commit ke
-- BAAD: outstanding 0 par floor + credit-insert fail = customer ka extra
-- paisa be-hisaab, hamesha ke liye. Ye file teen baat saabit karti hai:
--   1. Ek hi bhugtan me excess → utni hi 'open' credit, payment se linked.
--   2. Kishton me: excess sirf INCREMENTAL ginta hai (double nahi).
--   3. Reference-replay dobara credit nahi banata.
--
-- Sab rollback hota hai; synthetic tenant ke alawa kuch nahi chhoota.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('cccccccc-0000-0000-0000-0000000000c1'::uuid, 'OVERPAY TEST CO', 'overpay@example.in', '07');

insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values
  ('Q-OVER-ONE',  'cccccccc-0000-0000-0000-0000000000c1'::uuid, 'Over Cust A', 10000, 8475, 18, 'sent', 'awaiting', '[]'::jsonb),
  ('Q-OVER-INST', 'cccccccc-0000-0000-0000-0000000000c1'::uuid, 'Over Cust B', 10000, 8475, 18, 'sent', 'awaiting', '[]'::jsonb);

do $$
declare
  r    jsonb;
  v    record;
  n    integer;
begin
  -- ── 1. Ek bhugtan me ₹12,000 aaya, quote ₹10,000 ka ─────────────────────
  r := public.record_payment('Q-OVER-ONE', 12000, 'bank_transfer', 'over-ref-1', null);

  if coalesce((r->>'overpaid_credit')::int, -1) <> 2000 then
    raise exception 'FAIL 1a: overpaid_credit should be 2000, got %', r->>'overpaid_credit';
  end if;

  select amount, status, source, source_quote_id into v
    from public.customer_credits
   where source_payment_id = nullif(r->>'payment_id','')::uuid;
  if not found then
    raise exception 'FAIL 1b: no customer_credits row — the excess vanished (the exact audit bug)';
  end if;
  if v.amount <> 2000 or v.status <> 'open' or v.source <> 'overpayment' or v.source_quote_id <> 'Q-OVER-ONE' then
    raise exception 'FAIL 1c: credit row wrong (amount=% status=% source=% quote=%)', v.amount, v.status, v.source, v.source_quote_id;
  end if;

  -- ── 3. Wahi reference dobara — replay, koi NAYI credit nahi ─────────────
  r := public.record_payment('Q-OVER-ONE', 12000, 'bank_transfer', 'over-ref-1', null);
  if coalesce((r->>'idempotent_replay')::boolean, false) is not true then
    raise exception 'FAIL 3a: replay not detected';
  end if;
  select count(*) into n from public.customer_credits
   where source_quote_id = 'Q-OVER-ONE';
  if n <> 1 then
    raise exception 'FAIL 3b: replay minted another credit (count=%)', n;
  end if;

  -- ── 2. Kishtein: 6,000 (koi excess nahi) + 6,000 (excess 2,000 sirf) ─────
  r := public.record_payment('Q-OVER-INST', 6000, 'upi', 'inst-ref-1', null);
  if coalesce((r->>'overpaid_credit')::int, -1) <> 0 then
    raise exception 'FAIL 2a: partial payment minted a credit (%)', r->>'overpaid_credit';
  end if;

  r := public.record_payment('Q-OVER-INST', 6000, 'upi', 'inst-ref-2', null);
  if coalesce((r->>'overpaid_credit')::int, -1) <> 2000 then
    raise exception 'FAIL 2b: incremental excess should be 2000, got %', r->>'overpaid_credit';
  end if;
  select coalesce(sum(amount), 0) into n from public.customer_credits
   where source_quote_id = 'Q-OVER-INST';
  if n <> 2000 then
    raise exception 'FAIL 2c: total credit for installment quote should be 2000, got %', n;
  end if;

  raise notice 'PASS: overpayment credit is atomic, incremental, replay-safe';
end $$;

rollback;
