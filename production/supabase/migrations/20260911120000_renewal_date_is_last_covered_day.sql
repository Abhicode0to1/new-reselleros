-- ============================================================================
-- `subscriptions.renewal_date` becomes the LAST COVERED DAY — 11 Sep 2026.
--
-- WHY
--   Abhishek, looking at the Doodh Sang row: a subscription starting 11 Sep 2026
--   showed 11 Sept 2027, and "renewal date always 1 day less — it should be
--   10 Sept 2027". He reads the column as an EXPIRY date, which is also what the
--   Google Admin console he reconciles against shows, and as an expiry date
--   11 Sep 2027 is one day too many: the term covers 11 Sep 2026 → 10 Sep 2027,
--   365 days.
--
--   The column previously held the ANNIVERSARY — the first day of the next term.
--   Both conventions are defensible; only one can be stored, and the owner reads
--   this screen every day against a vendor console that uses the other one.
--
-- WHAT THIS DOES
--   Moves every renewal_date back exactly one day. Nothing else changes: not the
--   start dates, not the amounts, not term_months.
--
-- WHY THIS IS SAFE ONLY TOGETHER WITH THE CODE CHANGE
--   Every place that turned this column back into a term boundary was changed in
--   the same commit to go through nextTermStart() / termEndInclusive()
--   (src/lib/billing/schedule.ts). Without that, `nextTermSchedule` would open
--   term two on the last day of term one — one day sold twice, on every renewal of
--   every subscription, compounding silently. If you are cherry-picking, take both
--   or neither.
--
--   The roll-forward is deliberately untouched: an inclusive end plus twelve months
--   is the next inclusive end (10 Sep 2027 → 10 Sep 2028), so record_payment and
--   the renewal cron keep working on the stored value directly.
--
-- IDEMPOTENCE
--   This migration is NOT idempotent by nature — running it twice would shift the
--   dates two days. The guard below makes it refuse rather than corrupt: it records
--   its own completion and skips if already applied.
-- ============================================================================

create table if not exists public.schema_one_off_fixes (
  key         text primary key,
  applied_at  timestamptz not null default now(),
  note        text
);

comment on table public.schema_one_off_fixes is
  'Marker rows for one-off DATA corrections that are not safe to re-run. Schema '
  'changes do not need this — they are written idempotently. Value shifts are.';

do $$
declare
  v_key    text := 'renewal_date_inclusive_2026_09_11';
  v_moved  integer;
begin
  if exists (select 1 from public.schema_one_off_fixes where key = v_key) then
    raise notice 'SKIPPED: renewal_date was already shifted (marker %). Running it '
                 'again would move every date a second day.', v_key;
    return;
  end if;

  update public.subscriptions
     set renewal_date = renewal_date - interval '1 day'
   where renewal_date is not null;

  get diagnostics v_moved = row_count;

  insert into public.schema_one_off_fixes (key, note)
  values (v_key, format('Moved %s subscription renewal dates back one day: the column '
                        'now holds the last covered day, not the anniversary.', v_moved));

  raise notice 'Moved % renewal dates back one day.', v_moved;
end $$;

comment on column public.subscriptions.renewal_date is
  'The LAST DAY the subscription covers, inclusive. A 12-month term starting '
  '11 Sep 2026 holds 10 Sep 2027; the next term begins 11 Sep 2027. Changed from the '
  'anniversary convention on 11 Sep 2026 — see migration '
  '20260911120000_renewal_date_is_last_covered_day.sql. NEVER use this value directly '
  'as a period start: go through nextTermStart() in src/lib/billing/schedule.ts, or '
  'add a day in SQL. Adding months to it IS correct for a roll-forward.';
