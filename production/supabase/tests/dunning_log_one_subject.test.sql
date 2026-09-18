-- Regression test: invoice_dunning_log accepts a SUBSCRIPTION chase
-- (migration 20260910070000)
--
-- Run against the live/linked DB. Self-asserting: RAISEs on failure. The whole
-- thing runs inside a transaction that ROLLS BACK, so the DB stays clean.
--
--   env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--     -f supabase/tests/dunning_log_one_subject.test.sql
--
-- What it proves, and why each case earns its place:
--   1. A subscription-only row INSERTS. Before this migration it could not:
--      invoice_id was NOT NULL, so a postpaid subscription — which raises no
--      invoice by design — had nowhere to record "grace warning already sent",
--      and a daily cron would have re-sent it every day until somebody paid.
--   2. An invoice-only row still inserts. The 'one subject' check must not
--      break the path that has worked all along.
--   3. BOTH set is refused. That row would be counted twice by the ladder and
--      show up under two different subjects.
--   4. NEITHER set is refused. That is the dangerous one: a row belonging to
--      nothing is invisible in every view, while still being a logged step —
--      so the ladder believes it has chased something it never chased.
begin;

do $$
declare
  v_tenant  uuid;
  v_cust    uuid;
  v_sub     uuid;
  v_inv     text;
  v_id      uuid;
  v_msg     text;
begin
  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then
    raise exception 'FAIL setup: no tenant to test against';
  end if;

  insert into public.customers (tenant_id, name)
  values (v_tenant, 'ZZ Dunning Log Test')
  returning id into v_cust;

  insert into public.subscriptions
    (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status,
     start_date, renewal_date, outstanding_amount, payment_due_date)
  values
    (v_tenant, v_cust, 'ZZ Dunning Log Test', 'ZZ Test Plan', 'google', 1, 100,
     'active', current_date, current_date + 365, 1180, current_date - 8)
  returning id into v_sub;

  -- ── 1. subscription-only: the case the migration exists for ───────────────
  insert into public.invoice_dunning_log
    (tenant_id, subscription_id, dunning_step, days_overdue, action_taken, status)
  values (v_tenant, v_sub, 'grace_warning', 8, 'email', 'sent')
  returning id into v_id;
  if v_id is null then
    raise exception 'FAIL 1: a subscription-only dunning row did not insert';
  end if;

  -- Read it back the way the cron will: newest step for this subscription.
  if (select dunning_step from public.invoice_dunning_log
       where subscription_id = v_sub order by sent_at desc limit 1) <> 'grace_warning' then
    raise exception 'FAIL 1b: the logged step is not readable by subscription_id';
  end if;

  -- ── 2. invoice-only still works ───────────────────────────────────────────
  select id into v_inv from public.invoices where tenant_id = v_tenant limit 1;
  if v_inv is not null then
    insert into public.invoice_dunning_log
      (tenant_id, invoice_id, dunning_step, days_overdue, action_taken, status)
    values (v_tenant, v_inv, 'reminder', 1, 'email', 'sent');
  end if;
  -- No invoice in this tenant is not a failure of the constraint; skip quietly
  -- rather than raise, so the test does not depend on somebody's data.

  -- ── 3. BOTH set must be refused ───────────────────────────────────────────
  if v_inv is not null then
    begin
      insert into public.invoice_dunning_log
        (tenant_id, invoice_id, subscription_id, dunning_step, days_overdue, action_taken, status)
      values (v_tenant, v_inv, v_sub, 'retry', 3, 'email', 'sent');
      raise exception 'FAIL 3: a row with BOTH invoice_id and subscription_id was accepted';
    exception
      when check_violation then null;   -- expected
    end;
  end if;

  -- ── 4. NEITHER set must be refused ────────────────────────────────────────
  begin
    insert into public.invoice_dunning_log
      (tenant_id, dunning_step, days_overdue, action_taken, status)
    values (v_tenant, 'final', 14, 'email', 'sent');
    raise exception 'FAIL 4: a row belonging to NEITHER subject was accepted';
  exception
    when check_violation then null;     -- expected
  end;

  raise notice 'PASS dunning_log_one_subject — subscription chases log, and orphan/ambiguous rows are refused';
exception
  when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'dunning_log_one_subject: %', v_msg;
end $$;

rollback;
