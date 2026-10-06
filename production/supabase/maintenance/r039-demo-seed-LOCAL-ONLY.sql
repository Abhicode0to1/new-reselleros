-- R-039 DEMO SEED — LOCAL DEVELOPMENT DATABASE ONLY.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THIS FILE WRITES AND COMMITS. It is the opposite of                      ║
-- ║  r039-monthly-renewals-rolled-a-year.sql, which is read-only and is the   ║
-- ║  one that goes near production. Do not confuse them — hence the SHOUTING  ║
-- ║  in the filename.                                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHY IT EXISTS
--   The R-039 query is proved by supabase/tests/r039_damaged_renewals_query.test.sql,
--   but that runs inside a transaction that rolls back, so nothing is left to LOOK at.
--   This seeds the same scenario so the query can be run for real and the rows read on
--   screen, and so the subscriptions show up in the app at /subscriptions.
--
--   It is attached to the LOCAL "Anutech Digital" tenant (9fc56b3d…, the one
--   pardeep@anutech.in signs into here) rather than a tenant of its own, because a demo
--   nobody can see in the UI is only half a demo.
--
-- ─── THE GUARD, AND WHY IT IS A FINGERPRINT AND NOT A COMMENT ──────────────
--   "Local only" written in a comment stops nobody. This refuses to run if the
--   PRODUCTION Anutech tenant id is present — `fbb976f1-9090-4f10-9726-0901bd144e42`,
--   which exists on production and does not exist here (the local Anutech tenant is a
--   different uuid, 9fc56b3d…). A database name cannot tell them apart; this can.
--
--   It is also the honest shape of the risk: everything in here is named "DEMO", so on
--   production it would not corrupt anything — it would do something worse, which is put
--   four fake customers into a list of real ones that somebody is about to telephone.
--
-- RUN:
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres \
--     -f - < supabase/maintenance/r039-demo-seed-LOCAL-ONLY.sql
--
-- UNDO (removes every row this file created, and nothing else):
--   delete from public.quotes        where id like 'Q-DEMO-R039-%';
--   delete from public.subscriptions where customer_name like 'DEMO R-039 %';
--   delete from public.customers     where name          like 'DEMO R-039 %';

begin;

do $$
begin
  if exists (select 1 from public.tenants
              where id = 'fbb976f1-9090-4f10-9726-0901bd144e42') then
    raise exception
      'REFUSING: this is the PRODUCTION database (ANUTECH tenant fbb976f1… is present). This file seeds fake customers and must never run here.';
  end if;
end $$;

-- Four customers, named so they are unmistakable on any screen or list.
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('d0390000-0000-4000-8000-0000000000c1', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'DEMO R-039 Damaged Monthly',   '07', 'India'),
  ('d0390000-0000-4000-8000-0000000000c2', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'DEMO R-039 Damaged Quarterly', '07', 'India'),
  ('d0390000-0000-4000-8000-0000000000c3', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'DEMO R-039 Healthy Monthly',   '07', 'India'),
  ('d0390000-0000-4000-8000-0000000000c4', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'DEMO R-039 Early Renewer',     '07', 'India')
on conflict (id) do nothing;

insert into public.subscriptions
  (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
   renewal_date, billing_cycle, domain, status) values

  -- ① DAMAGED. The exact case from the bug report: ₹250/month, renewal rolled a full
  --    year, MRR divided by 12 instead of by 1.
  ('d0390000-0000-4000-8000-0000000000a1', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7',
   'd0390000-0000-4000-8000-0000000000c1', 'DEMO R-039 Damaged Monthly',
   'Starter hosting (monthly)', 'hosting', 1, 21, 1,
   (current_date + interval '12 months')::date, 'monthly', 'demo-damaged.in', 'active'),

  -- ② DAMAGED. Quarterly is also shorter than a year, so the same 12 hurt it.
  --    ₹750 a quarter became an MRR of 62 instead of 250.
  ('d0390000-0000-4000-8000-0000000000a2', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7',
   'd0390000-0000-4000-8000-0000000000c2', 'DEMO R-039 Damaged Quarterly',
   'Plus hosting (quarterly)', 'hosting', 1, 62, 3,
   (current_date + interval '12 months')::date, 'monthly', 'demo-quarterly.in', 'active'),

  -- ③ HEALTHY. An ordinary monthly subscription, due next month. Must NOT be listed.
  ('d0390000-0000-4000-8000-0000000000a3', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7',
   'd0390000-0000-4000-8000-0000000000c3', 'DEMO R-039 Healthy Monthly',
   'Starter hosting (monthly)', 'hosting', 1, 250, 1,
   (current_date + interval '20 days')::date, 'monthly', 'demo-healthy.in', 'active'),

  -- ④ THE NEAR MISS. Renewed three weeks EARLY, so it sits further out than a month and
  --    is perfectly fine. This is the row the 45-day slack exists for; without it this
  --    customer gets a phone call about a problem they do not have.
  ('d0390000-0000-4000-8000-0000000000a4', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7',
   'd0390000-0000-4000-8000-0000000000c4', 'DEMO R-039 Early Renewer',
   'Starter hosting (monthly)', 'hosting', 1, 250, 1,
   (current_date + interval '40 days')::date, 'monthly', 'demo-early.in', 'active')
on conflict (id) do nothing;

-- The paid renewal quotes that caused ① and ②. These carry the bug's signature:
-- is_renewal, extension_months = 12, and money actually received.
insert into public.quotes
  (id, tenant_id, customer_id, customer_name, plan, amount, subtotal, tax_rate, status,
   payment_status, line_items, is_renewal, extension_months, created_date, payment_received_at) values
  ('Q-DEMO-R039-0001', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'd0390000-0000-4000-8000-0000000000c1',
   'DEMO R-039 Damaged Monthly', 'Starter hosting (monthly)', 295, 250, 18, 'accepted', 'received',
   '[]'::jsonb, true, 12, current_date - 20, (current_date - 20)::timestamptz),
  ('Q-DEMO-R039-0002', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'd0390000-0000-4000-8000-0000000000c2',
   'DEMO R-039 Damaged Quarterly', 'Plus hosting (quarterly)', 885, 750, 18, 'accepted', 'received',
   '[]'::jsonb, true, 12, current_date - 10, (current_date - 10)::timestamptz),
  /* An UNPAID renewal quote on the healthy monthly subscription — the bug's signature in
     every way except the one that matters. It must not pull a healthy customer in. */
  ('Q-DEMO-R039-0003', '9fc56b3d-3958-4d40-ba37-237d4cfe2ea7', 'd0390000-0000-4000-8000-0000000000c3',
   'DEMO R-039 Healthy Monthly', 'Starter hosting (monthly)', 295, 250, 18, 'sent', 'awaiting',
   '[]'::jsonb, true, 12, current_date - 5, null)
on conflict (id) do nothing;

commit;
