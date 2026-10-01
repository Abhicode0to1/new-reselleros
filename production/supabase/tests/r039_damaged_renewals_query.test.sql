-- Regression test for the R-039 LIST QUERY (supabase/maintenance/r039-monthly-renewals-rolled-a-year.sql).
-- Rolled back — safe on production, though it is meant to be run locally.
--
-- ─── WHY A QUERY NEEDS A TEST ──────────────────────────────────────────────
-- This query's output becomes a list of real customers Pardeep may ring up. Both
-- ways of being wrong are expensive and NEITHER is visible from the result:
--
--   a name that should NOT be there  → a customer is contacted about a problem
--                                      they do not have
--   a name that is MISSING           → a customer keeps a year of unpaid service
--                                      and nobody ever knows
--
-- An empty result is a legitimate answer to R-039 ("nobody was affected"), which is
-- exactly why the query cannot be trusted until it has been shown to find a row it
-- SHOULD find. A query that returns nothing because its WHERE clause is wrong looks
-- identical to good news.
--
-- So the fixture below contains six subscriptions: three that must appear and three
-- that must not, including the near-miss case (an early renewal inside the slack).
--
-- ─── ONE DUPLICATION, STATED ───────────────────────────────────────────────
-- The SELECT is repeated here rather than included from the maintenance file,
-- because that file opens its own transaction and rolls back, which would discard
-- this fixture mid-test. The three load-bearing predicates are pinned against the
-- real file by src/lib/ops/r039-query-drift.test.ts, so the copies cannot drift
-- apart silently.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('03900000-0000-4000-8000-000000000001', 'R039 TEST', 'r039@example.in', '07', 'R39T');

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('03900000-0000-4000-8000-0000000000c1', '03900000-0000-4000-8000-000000000001', 'Damaged Monthly', '07', 'India'),
  ('03900000-0000-4000-8000-0000000000c2', '03900000-0000-4000-8000-000000000001', 'Healthy Monthly', '07', 'India'),
  ('03900000-0000-4000-8000-0000000000c3', '03900000-0000-4000-8000-000000000001', 'Healthy Annual',  '07', 'India'),
  ('03900000-0000-4000-8000-0000000000c4', '03900000-0000-4000-8000-000000000001', 'Early Renewer',   '07', 'India'),
  ('03900000-0000-4000-8000-0000000000c5', '03900000-0000-4000-8000-000000000001', 'Damaged Quarterly','07', 'India'),
  ('03900000-0000-4000-8000-0000000000c6', '03900000-0000-4000-8000-000000000001', 'Damaged NoQuote', '07', 'India');

-- ── The six subscriptions ────────────────────────────────────────────────────
insert into public.subscriptions
  (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, renewal_date, domain) values
  -- 1. MUST APPEAR — the exact case from R-012: ₹250/month, rolled a year, MRR 250→21.
  ('03900000-0000-4000-8000-0000000000a1', '03900000-0000-4000-8000-000000000001',
   '03900000-0000-4000-8000-0000000000c1', 'Damaged Monthly', 'Starter hosting', 'hosting', 1, 21,
   1, (current_date + interval '12 months')::date, 'damaged.in'),
  -- 2. must NOT appear — an ordinary monthly subscription, due next month.
  ('03900000-0000-4000-8000-0000000000a2', '03900000-0000-4000-8000-000000000001',
   '03900000-0000-4000-8000-0000000000c2', 'Healthy Monthly', 'Starter hosting', 'hosting', 1, 250,
   1, (current_date + interval '20 days')::date, 'healthy.in'),
  /* 3. must NOT appear — a YEARLY subscription, renewed twice, now due in 20 months.
        R-012 wrote extension_months = 12 and this term IS 12, so nothing was wrong:
        a year was paid for and a year was given. The date is deliberately set FAR
        out rather than next month, because at 11 months this row sat inside the
        threshold anyway and the `term_months < 12` guard was never exercised —
        widening it to `<= 12` kept the test green, which made that guard a line
        nobody was checking. Now it goes red. */
  ('03900000-0000-4000-8000-0000000000a3', '03900000-0000-4000-8000-000000000001',
   '03900000-0000-4000-8000-0000000000c3', 'Twice-renewed Annual', 'Business Standard', 'google', 5, 5000,
   12, (current_date + interval '20 months')::date, 'annual.in'),
  /* 4. must NOT appear — THE NEAR MISS, and the reason the 45-day slack exists.
        A monthly subscription renewed a few weeks early sits further out than one
        month and is perfectly healthy. If the slack were removed this row would be
        on the list and a customer would get a phone call about nothing. */
  ('03900000-0000-4000-8000-0000000000a4', '03900000-0000-4000-8000-000000000001',
   '03900000-0000-4000-8000-0000000000c4', 'Early Renewer', 'Starter hosting', 'hosting', 1, 250,
   1, (current_date + interval '40 days')::date, 'early.in'),
  -- 5. MUST APPEAR — quarterly is also < 12 months, so R-012 hurt it the same way.
  ('03900000-0000-4000-8000-0000000000a5', '03900000-0000-4000-8000-000000000001',
   '03900000-0000-4000-8000-0000000000c5', 'Damaged Quarterly', 'Plus hosting', 'hosting', 1, 75,
   3, (current_date + interval '12 months')::date, 'quarterly.in'),
  -- 6. MUST APPEAR with mrr_correct NULL — damaged, but no quote can be matched.
  ('03900000-0000-4000-8000-0000000000a6', '03900000-0000-4000-8000-000000000001',
   '03900000-0000-4000-8000-0000000000c6', 'Damaged NoQuote', 'Mystery plan', 'other', 1, 9,
   1, (current_date + interval '14 months')::date, 'noquote.in');

-- ── The paid renewal quotes that caused 1 and 5 ──────────────────────────────
insert into public.quotes
  (id, tenant_id, customer_id, customer_name, plan, amount, subtotal, tax_rate, status, payment_status,
   line_items, is_renewal, extension_months, created_date, payment_received_at) values
  ('Q-R39T-27-0001', '03900000-0000-4000-8000-000000000001', '03900000-0000-4000-8000-0000000000c1',
   'Damaged Monthly', 'Starter hosting', 295, 250, 18, 'accepted', 'received', '[]'::jsonb,
   true, 12, current_date - 20, (current_date - 20)::timestamptz),
  ('Q-R39T-27-0002', '03900000-0000-4000-8000-000000000001', '03900000-0000-4000-8000-0000000000c5',
   'Damaged Quarterly', 'Plus hosting', 885, 750, 18, 'accepted', 'received', '[]'::jsonb,
   true, 12, current_date - 10, (current_date - 10)::timestamptz),
  /* An UNPAID renewal quote on the healthy monthly subscription. It carries the
     bug's signature in every way except the one that matters — no money moved — so
     it must not pull a healthy customer onto the list. */
  ('Q-R39T-27-0003', '03900000-0000-4000-8000-000000000001', '03900000-0000-4000-8000-0000000000c2',
   'Healthy Monthly', 'Starter hosting', 295, 250, 18, 'sent', 'awaiting', '[]'::jsonb,
   true, 12, current_date - 5, null);

do $$
declare
  v_n        int;
  v_rec      record;
begin
  create temp table r039_result on commit drop as
  with
  damaged as (
    select
      s.id            as subscription_id,
      s.tenant_id,
      s.customer_id,
      s.customer_name,
      s.plan,
      s.domain,
      s.seats,
      s.term_months,
      s.billing_cycle,
      s.renewal_date,
      s.mrr,
      s.renewal_state,
      s.status
    from public.subscriptions s
    where s.term_months is not null
      and s.term_months < 12
      and s.renewal_date is not null
      and s.renewal_date > (current_date
                            + (s.term_months || ' months')::interval
                            + interval '45 days')
  ),
  culprit as (
    select distinct on (q.tenant_id, q.customer_id, q.plan)
      q.tenant_id,
      q.customer_id,
      q.plan,
      q.id              as quote_id,
      q.subtotal        as quote_subtotal,
      q.amount          as quote_amount,
      coalesce(q.payment_received_at::date, q.created_date) as paid_date,
      q.extension_months
    from public.quotes q
    where q.is_renewal is true
      and q.extension_months = 12
      and q.payment_status in ('received', 'invoiced')
    order by q.tenant_id, q.customer_id, q.plan,
             coalesce(q.payment_received_at::date, q.created_date) desc
  ),
  culprit_count as (
    select q.tenant_id, q.customer_id, q.plan, count(*) as n
    from public.quotes q
    where q.is_renewal is true
      and q.extension_months = 12
      and q.payment_status in ('received', 'invoiced')
    group by 1, 2, 3
  )
  select
    t.name                      as tenant,
    d.customer_name             as customer,
    d.plan,
    d.domain,
    d.seats,
    d.term_months,
    d.billing_cycle,
    d.status                    as subscription_status,
    c.quote_id,
    c.paid_date,
    c.quote_subtotal,
    d.renewal_date              as renewal_date_now,
    d.mrr                       as mrr_now,
    (d.renewal_date - interval '12 months'
                    + (d.term_months || ' months')::interval)::date
                                as renewal_date_correct,
    case
      when c.quote_subtotal is not null and d.term_months > 0
        then round(c.quote_subtotal::numeric / d.term_months)::int
      else null
    end                         as mrr_correct,
    (d.renewal_date - (d.renewal_date - interval '12 months'
                                      + (d.term_months || ' months')::interval)::date)
                                as days_of_free_service,
    coalesce(cc.n, 0)           as paid_12m_renewal_quotes,
    case
      when c.quote_id is null  then 'NO MATCHING QUOTE — damage is real, cause not matched; check by hand'
      when coalesce(cc.n, 0) > 1 then 'RENEWED MORE THAN ONCE — correction above subtracts only one year'
      else 'single renewal — correction above is complete'
    end                         as note,
    d.subscription_id
  from damaged d
  join public.tenants t
    on t.id = d.tenant_id
  left join culprit c
    on  c.tenant_id   = d.tenant_id
    and c.customer_id is not distinct from d.customer_id
    and c.plan        = d.plan
  left join culprit_count cc
    on  cc.tenant_id   = d.tenant_id
    and cc.customer_id is not distinct from d.customer_id
    and cc.plan        = d.plan
  order by t.name, days_of_free_service desc, d.customer_name;

  -- ── Exactly the three damaged rows, and nothing else ──────────────────────
  select count(*) into v_n from r039_result;
  if v_n <> 3 then
    raise exception 'FAIL 1: expected 3 damaged subscriptions, got % — the list is % ',
      v_n, case when v_n > 3 then 'pulling in healthy customers' else 'hiding damaged ones' end;
  end if;

  if exists (select 1 from r039_result where customer = 'Healthy Monthly') then
    raise exception 'FAIL 2: an ordinary monthly subscription was listed as damaged';
  end if;
  if exists (select 1 from r039_result where customer = 'Twice-renewed Annual') then
    raise exception 'FAIL 3: a YEARLY subscription was listed — R-012 wrote 12 and its term IS 12, so nothing was ever wrong with it';
  end if;
  /* The near miss. Removing the 45-day slack turns this assertion red, which is the
     whole point of having it: a customer who renewed three weeks early must not be
     rung up about a problem they do not have. */
  if exists (select 1 from r039_result where customer = 'Early Renewer') then
    raise exception 'FAIL 4: a monthly subscription renewed EARLY was listed as damaged';
  end if;

  -- ── The numbers on the row Pardeep will act on ────────────────────────────
  select * into v_rec from r039_result where customer = 'Damaged Monthly';
  if v_rec.quote_id <> 'Q-R39T-27-0001' then
    raise exception 'FAIL 5: wrong quote matched (%) — the evidence column would mislead', coalesce(v_rec.quote_id, '<null>');
  end if;
  if v_rec.mrr_now <> 21 or v_rec.mrr_correct <> 250 then
    raise exception 'FAIL 5: MRR reported as % -> %, expected 21 -> 250', v_rec.mrr_now, v_rec.mrr_correct;
  end if;
  if v_rec.renewal_date_correct <> (current_date + interval '1 month')::date then
    raise exception 'FAIL 5: corrected renewal date is %, expected %',
      v_rec.renewal_date_correct, (current_date + interval '1 month')::date;
  end if;
  /* 12 months taken, 1 month paid for — the number that says how much service was
     given away, which is what makes this a money list and not a data-quality list. */
  if v_rec.days_of_free_service < 330 then
    raise exception 'FAIL 5: free service reported as only % days', v_rec.days_of_free_service;
  end if;

  -- Quarterly: paid ₹750 for a quarter, so the right MRR is 750/3, not 750/12.
  select * into v_rec from r039_result where customer = 'Damaged Quarterly';
  if v_rec.mrr_correct <> 250 then
    raise exception 'FAIL 6: quarterly MRR corrected to %, expected 750/3 = 250', v_rec.mrr_correct;
  end if;

  -- No quote matched: unknown must be reported as unknown, never filled in.
  select * into v_rec from r039_result where customer = 'Damaged NoQuote';
  if v_rec.mrr_correct is not null then
    raise exception 'FAIL 7: an MRR was invented (%) for a row with no matching quote', v_rec.mrr_correct;
  end if;
  if v_rec.note not like 'NO MATCHING QUOTE%' then
    raise exception 'FAIL 7: the row does not say its cause is unmatched — it reads "%"', v_rec.note;
  end if;

  raise notice 'PASS: 3 damaged listed (monthly, quarterly, unmatched); healthy, annual and early-renewed left alone';
end $$;

rollback;
