-- Step 2 of clearing ANUTECH's test data: remove the customers, which takes the
-- subscriptions with them.
--
-- Written 22 Aug 2026 at Pardeep's request. He confirmed the data in
-- fbb976f1-9090-4f10-9726-0901bd144e42 is all test data he entered while trying the app,
-- and that he will re-enter it properly.
--
-- ─── RUN THIS *AFTER* THE RESET BUTTON, NOT BEFORE ──────────────────────────
-- `payments_customer_id_fkey` is NO ACTION, so while any payment still points at a
-- customer this delete FAILS. Settings → Reset data deletes the quotes, and
-- `payments_quote_id_fkey` is CASCADE, so the payments go with them. Only then is the
-- path clear. Part A below refuses to run if that has not happened yet.
--
-- ─── WHAT GOES, MEASURED BEFORE WRITING THIS ────────────────────────────────
--   26 customers                       (the delete itself)
--   44 subscriptions                   CASCADE, subscriptions_customer_id_fkey
--    1 customer_users portal login     CASCADE
--    0 vault_passwords                 CASCADE — nothing there, so no customer
--                                      passwords are lost
--    0 customer_domains / customer_credits / payment_mandates / referral_agreements /
--      mrr_snapshots                   all already empty
--
-- SET NULL, so these SURVIVE and merely lose the customer link: support_tickets (4),
-- contacts, credit_notes, debit_notes, purchase_orders, tds_receivable, vault_access_log.
--
-- KEPT ON PURPOSE (Pardeep's choice, 22 Aug): items (25), employees (10),
-- bank_accounts (2), bank_transactions (39), expenses (35), salary_payments (22),
-- support_tickets (4). And the document series is NOT reset — the next invoice will be
-- INV-ADPL-2026-27-0033. Leaving a GST series alone is the safe choice.

-- ════════════════════════════════════════════════════════════════════════════
-- PART A — DRY RUN. Run this first, on its own. It changes nothing.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $$
declare
  v_tenant uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  v_pay int; v_cust int; v_sub int; v_q int; v_inv int;
begin
  select count(*) into v_pay  from public.payments      where tenant_id = v_tenant;
  select count(*) into v_q    from public.quotes        where tenant_id = v_tenant;
  select count(*) into v_inv  from public.invoices      where tenant_id = v_tenant;
  select count(*) into v_cust from public.customers     where tenant_id = v_tenant;
  select count(*) into v_sub  from public.subscriptions where tenant_id = v_tenant;

  if v_pay > 0 then
    raise exception
      'STOP: % payment(s) still exist, so deleting a customer will fail on payments_customer_id_fkey (NO ACTION). Press the reset button in Settings first — it deletes the quotes and the payments follow. Nothing has been changed.', v_pay;
  end if;

  raise exception
    'DRY RUN — nothing changed. quotes=% invoices=% payments=% | would delete customers=% and subscriptions=% (via CASCADE)',
    v_q, v_inv, v_pay, v_cust, v_sub;
end $$;

rollback;

-- ════════════════════════════════════════════════════════════════════════════
-- PART B — THE REAL RUN. Only after Part A reported payments=0 and the counts
-- look right. Run this on its own too.
--
-- No verification SELECT lives inside this transaction, deliberately: inside an
-- uncommitted transaction it would report success for a change that has not landed
-- yet (CLAUDE.md §25.6). Verify with PART C, in a separate run.
-- ════════════════════════════════════════════════════════════════════════════
/*
begin;

-- A restore point of our own. The reset button already took one, but that was before
-- this delete, so it cannot bring these rows back on its own.
select backup._take(
  'fbb976f1-9090-4f10-9726-0901bd144e42'::uuid,
  'Before clearing test customers + subscriptions',
  'manual');

do $$
declare
  v_tenant uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  v_pay int;
begin
  -- The same guard again. Part A proving it earlier is not the same as it being true now.
  select count(*) into v_pay from public.payments where tenant_id = v_tenant;
  if v_pay > 0 then
    raise exception 'STOP: % payment(s) exist — reset the quotes first. Nothing has been changed.', v_pay;
  end if;

  delete from public.customers where tenant_id = v_tenant;
end $$;

commit;
*/

-- ════════════════════════════════════════════════════════════════════════════
-- PART C — VERIFY, in a run of its own. Expect every number to be 0 except the
-- ones deliberately kept.
-- ════════════════════════════════════════════════════════════════════════════
/*
select 'customers'         as t, count(*) from public.customers     where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'subscriptions',       count(*) from public.subscriptions where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'quotes',              count(*) from public.quotes        where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'invoices',            count(*) from public.invoices      where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'payments',            count(*) from public.payments      where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'leads',               count(*) from public.leads         where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'KEPT items',          count(*) from public.items         where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'KEPT employees',      count(*) from public.employees     where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'KEPT bank_accounts',  count(*) from public.bank_accounts where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'KEPT expenses',       count(*) from public.expenses      where tenant_id='fbb976f1-9090-4f10-9726-0901bd144e42'
order by 1;
*/
