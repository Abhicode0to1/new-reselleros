-- Regression test for the referral-commission auto-accrual trigger (migration 0156).
--
-- Proves:
--   T1  one_time percent + TDS on a DOMESTIC deal → base is ex-GST, 5% TDS split correct,
--       and a SECOND payment from the same customer does NOT accrue again.
--   T2  recurring percent on an EXPORT deal (tax_rate 0) → base is the full amount because
--       there is no GST to strip, no TDS, and EVERY payment accrues.
--   T3  a refunded payment must NOT accrue.
--
-- ─── REWRITTEN 22 Aug 2026 ──────────────────────────────────────────────────
-- It hardcoded the live tenant and the customer `53db44e6…` (since deleted), so it inserted
-- quotes, payments, partners and agreements into ANUTECH's books and died on an FK once that
-- customer went. Its own header said "Swap the tenant/customer UUIDs for your own before
-- running" — an instruction that made the committed file un-runnable by anyone who did not
-- edit it first, which is the same as not having it. See AGENTS.md L11.
--
-- It also asserted nothing: three cases, ten numbers, all formatted into one
-- `TESTRESULT >>` message with the expected figures in brackets for a human to check.
-- Every one of those numbers is now an assertion.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c0de0006-0000-4000-8000-000000000001', 'REFERRAL TEST', 'ref@example.in', '07', 'RFT1');

insert into public.customers (id, tenant_id, name, country, state_code, state)
  values ('c0de0006-0000-4000-8000-0000000000c1', 'c0de0006-0000-4000-8000-000000000001',
          'Referral Cust', 'India', '07', 'Delhi');

do $$
declare
  v_tenant  uuid := 'c0de0006-0000-4000-8000-000000000001';
  v_cust    uuid := 'c0de0006-0000-4000-8000-0000000000c1';
  v_partner uuid;
  v_agr1    uuid;
  v_agr2    uuid;
  r         record;
  v_cnt     int;
begin
  insert into public.referral_partners (tenant_id, name, deduct_tds, tds_rate)
    values (v_tenant, 'TEST Partner', true, 5) returning id into v_partner;

  -- ── T1: one_time percent 10 + TDS 5, domestic (tax_rate 18) ───────────────
  insert into public.referral_agreements
      (tenant_id, partner_id, customer_id, basis, percent, scope, deduct_tds, tds_rate, status)
    values (v_tenant, v_partner, v_cust, 'percent', 10, 'one_time', true, 5, 'active')
    returning id into v_agr1;

  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount)
    values ('TESTQ-DOM-1', v_tenant, 'Referral Cust', v_cust, 18, 11800);
  insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at)
    values (gen_random_uuid(), v_tenant, 'TESTQ-DOM-1', v_cust, 11800, 'upi', 'received', now(), now());

  select base_amount, gross_commission, tds_amount, net_payable into r
    from public.referral_commissions where agreement_id = v_agr1;

  /* ₹11,800 received on an 18% deal. The commission base is the EX-GST 10,000 — the 1,800 of
     GST is the government's, never the partner's, and paying 10% of the gross would hand over
     ₹1,180 of which ₹180 was never the reseller's to give. */
  if r.base_amount       <> 10000 then raise exception 'FAIL T1: base_amount %, expected 10000 (ex-GST of 11800 at 18%%)', r.base_amount; end if;
  if r.gross_commission  <> 1000  then raise exception 'FAIL T1: gross_commission %, expected 1000 (10%% of 10000)', r.gross_commission; end if;
  if r.tds_amount        <> 50    then raise exception 'FAIL T1: tds_amount %, expected 50 (5%% of 1000)', r.tds_amount; end if;
  if r.net_payable       <> 950   then raise exception 'FAIL T1: net_payable %, expected 950 (1000 - 50)', r.net_payable; end if;

  -- ── T1b: one_time means ONCE, however many payments arrive ────────────────
  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount)
    values ('TESTQ-DOM-2', v_tenant, 'Referral Cust', v_cust, 18, 11800);
  insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at)
    values (gen_random_uuid(), v_tenant, 'TESTQ-DOM-2', v_cust, 11800, 'upi', 'received', now(), now());

  select count(*) into v_cnt from public.referral_commissions where agreement_id = v_agr1;
  if v_cnt <> 1 then
    raise exception 'FAIL T1b: % commissions on a one_time agreement after 2 payments, expected 1 — the partner is being paid twice for one introduction', v_cnt;
  end if;

  update public.referral_agreements set status = 'closed' where id = v_agr1;

  -- ── T2: recurring percent 10, export (tax_rate 0), no TDS ────────────────
  insert into public.referral_agreements
      (tenant_id, partner_id, customer_id, basis, percent, scope, deduct_tds, status)
    values (v_tenant, v_partner, v_cust, 'percent', 10, 'recurring', false, 'active')
    returning id into v_agr2;

  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount)
    values ('TESTQ-EXP-1', v_tenant, 'Referral Cust', v_cust, 0, 5000);
  insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at)
    values (gen_random_uuid(), v_tenant, 'TESTQ-EXP-1', v_cust, 5000, 'upi', 'received', now(), now());

  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount)
    values ('TESTQ-EXP-2', v_tenant, 'Referral Cust', v_cust, 0, 5000);
  insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at)
    values (gen_random_uuid(), v_tenant, 'TESTQ-EXP-2', v_cust, 5000, 'upi', 'received', now(), now());

  select count(*) into v_cnt from public.referral_commissions where agreement_id = v_agr2;
  if v_cnt <> 2 then
    raise exception 'FAIL T2: % commissions on a recurring agreement after 2 payments, expected 2', v_cnt;
  end if;

  select base_amount, gross_commission, tds_amount, net_payable into r
    from public.referral_commissions where agreement_id = v_agr2 limit 1;

  /* tax_rate 0 — an export. There is no GST inside the 5,000, so stripping any would
     shrink the partner's base for a tax nobody charged. */
  if r.base_amount      <> 5000 then raise exception 'FAIL T2: base_amount %, expected 5000 (no GST to strip on an export)', r.base_amount; end if;
  if r.gross_commission <> 500  then raise exception 'FAIL T2: gross_commission %, expected 500', r.gross_commission; end if;
  if r.tds_amount       <> 0    then raise exception 'FAIL T2: tds_amount %, expected 0 (deduct_tds false)', r.tds_amount; end if;
  if r.net_payable      <> 500  then raise exception 'FAIL T2: net_payable %, expected 500', r.net_payable; end if;

  -- ── T3: a refunded payment must not accrue ───────────────────────────────
  insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount)
    values ('TESTQ-REF-1', v_tenant, 'Referral Cust', v_cust, 18, 11800);
  insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, refunded_at, created_at)
    values (gen_random_uuid(), v_tenant, 'TESTQ-REF-1', v_cust, 11800, 'upi', 'received', now(), now(), now());

  select count(*) into v_cnt from public.referral_commissions where agreement_id = v_agr2;
  if v_cnt <> 2 then
    /* Money that came back out must not leave a commission behind, or the reseller pays a
       partner out of a sale that was undone. */
    raise exception 'FAIL T3: % commissions after a REFUNDED payment, expected still 2', v_cnt;
  end if;

  raise notice 'PASS: ex-GST base, TDS split, one_time accrues once, recurring accrues per payment, refunds do not accrue';
end $$;

select 'PASS' as accrue_referral_commission;

rollback;
