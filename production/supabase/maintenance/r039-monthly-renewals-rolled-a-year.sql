-- R-039 — WHICH subscriptions did the R-012 bug actually damage on production?
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  READ-ONLY. There is no INSERT, UPDATE, DELETE or DDL in this file, and   ║
-- ║  it is wrapped in a transaction that ROLLS BACK, so it cannot write even  ║
-- ║  if someone later pastes a statement into the middle of it.               ║
-- ║  Pardeep decides what to do with the list; this only produces the list.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ─── THE BUG (R-012, now fixed in create-renewal-quote.ts) ──────────────────
-- Every renewal quote said `extension_months: 12`, monthly subscriptions included.
-- When such a quote was paid, record_payment did two things with that 12:
--
--     renewal_date = renewal_date + (12 || ' months')::interval
--     mrr          = round(subtotal / 12)
--
-- So a ₹250/month subscription that renewed for ₹250 got a YEAR of service for one
-- month's money, and its MRR fell to ₹21. Measured locally: renewal 25 Oct 2026 →
-- 25 Oct 2027, mrr 250 → 21.
--
-- ─── WHY THIS IS NOT A SIMPLE JOIN ─────────────────────────────────────────
-- The obvious query would follow `subscriptions.renewal_quote_id` back to the quote
-- that caused it. That link does not survive: record_payment sets
-- `renewal_quote_id = null` in the same UPDATE that moves the date. By the time
-- the damage exists, the evidence of which quote did it has been cleared, and
-- `quotes` has no subscription_id column to go the other way.
--
-- So this file does not depend on finding the quote. It finds the damage, which is
-- visible in the subscription row ON ITS OWN:
--
--     a subscription whose term is shorter than a year cannot have a renewal date
--     more than its own term away from today.
--
-- A monthly subscription renewed this morning is due in ~1 month. One due in 2027
-- was not renewed for a month, whatever any other table says. That is an internal
-- contradiction in a single row — it needs no join and cannot be argued with.
--
-- The quote is then attached as EVIDENCE where it can be found (section B), by
-- customer + plan, because it carries the `subtotal` that the correct MRR is
-- computed from. Where no quote matches, the row still appears: a damaged
-- subscription must not drop off the list because its paperwork is untidy.
--
-- ─── WHAT "CORRECT" MEANS HERE ─────────────────────────────────────────────
--   renewal_date_correct = renewal_date − (12 × n) months + (term_months × n)
--   mrr_correct          = round(quote subtotal / term_months)
-- where n = how many 12-month renewals were applied. n is ASSUMED to be 1 and the
-- real count is reported beside it (`paid_12m_renewal_quotes`) rather than guessed
-- at, because a subscription renewed twice was shifted twice and one subtraction
-- would under-correct it. Any row where that count is not 1 needs a human to look.
--
-- HOW TO RUN (production, read-only):
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/maintenance/r039-monthly-renewals-rolled-a-year.sql
-- To hand Pardeep a CSV instead:
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 --csv -f …  > r039.csv
--
-- IF IT RETURNS NOTHING that is a real answer and must be reported as one: it means
-- no monthly/quarterly subscription was ever renewed through the broken path.

begin;

-- Nothing in this transaction may write, whatever is pasted below.
set local transaction read only;
set local statement_timeout = '120s';

with
-- ── A. The damage, from the subscription row alone ────────────────────────
--   `term_months < 12` is the population R-012 could hurt; a 12-month subscription
--   renewed for 12 months was correct all along.
--   The `+ 45 days` is slack, not a fudge: a subscription may legitimately be renewed
--   a few weeks early, and a quarterly one sits up to 3 months out by design. It has
--   to be wide enough that an ordinary early renewal never appears on a list Pardeep
--   is asked to act on — a false name on this list costs a customer conversation.
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

-- ── B. The paid renewal quote that did it, where one can still be matched ──
--   Matched on tenant + customer + plan, not on an id, because the id link was
--   erased (see the header). Narrowed to quotes that actually carry the bug's
--   signature: a renewal, extension_months = 12, and money received.
--   DISTINCT ON picks the most recent such quote — the one whose subtotal the
--   current (wrong) MRR was computed from.
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

-- ── C. How many such quotes exist per subscription-ish key ────────────────
--   Reported, not applied. More than one means the date was pushed forward more
--   than once and the single-subtraction correction below is not enough.
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

  -- current, wrong
  d.renewal_date              as renewal_date_now,
  d.mrr                       as mrr_now,

  -- what it should be, if exactly ONE broken renewal was applied
  (d.renewal_date - interval '12 months'
                  + (d.term_months || ' months')::interval)::date
                              as renewal_date_correct,
  case
    when c.quote_subtotal is not null and d.term_months > 0
      then round(c.quote_subtotal::numeric / d.term_months)::int
    else null                 -- no matching quote: say unknown, never guess (AGENTS.md §2)
  end                         as mrr_correct,

  -- how far wrong, in plain numbers
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

rollback;
