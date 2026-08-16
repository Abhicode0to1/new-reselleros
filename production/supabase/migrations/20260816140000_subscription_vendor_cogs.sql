-- 20260816140000_subscription_vendor_cogs
--
-- WHAT THIS ADDS
--   subscriptions.vendor_seats                what the vendor has PROVISIONED for us
--   subscriptions.vendor_cost_per_seat_month  ₹/seat/month we are actually charged
--   subscriptions.vendor_synced_at            when those two were last confirmed
--
-- WHY THESE ARE NOT DERIVED FROM THE CATALOGUE
--   `items.wholesale` is the price list — what a plan is SUPPOSED to cost. These
--   columns are what the vendor actually billed. They are usually the same and the
--   gap is exactly what matters: a promo that ended, a band the account fell out of,
--   or seats provisioned by someone at the customer's end that nobody told us about.
--   Deriving COGS from the price list would make that gap unobservable by
--   construction.
--
-- WHY vendor_seats IS NULLABLE AND HAS NO DEFAULT
--   NULL means "never reconciled against the vendor", and that is a different fact
--   from zero. Defaulting to 0 would report every unchecked subscription as having no
--   leakage — a clean tick on precisely the rows nobody has looked at. See
--   lib/vendor/leakage.ts, which treats null as `unknown` and says so on screen.
--
-- WHY vendor_synced_at MATTERS ON ITS OWN
--   A seat count from four months ago is not a fact about today. Without the
--   timestamp, a stale reconciliation and a fresh one look identical, and the older
--   one is the more dangerous because it is trusted.
--
-- WHERE THE DATA COMES FROM — AND WHAT DOES NOT EXIST
--   The Google reseller CSV export, through the existing Reconcile dialog
--   (components/features/subscriptions/reconcile-google-dialog.tsx), whose match key
--   is the service domain. There is NO Google CSP or Microsoft Partner Center API
--   credential on this project; both require partner onboarding, which is a
--   commercial process rather than a code change. Nothing here fetches anything.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) filter (where vendor_seats is null)     as never_reconciled,
--          count(*) filter (where vendor_seats is not null) as reconciled
--     from public.subscriptions;
--   -- expect every existing row in never_reconciled

begin;

alter table public.subscriptions
  add column if not exists vendor_seats               integer,
  add column if not exists vendor_cost_per_seat_month integer,
  add column if not exists vendor_synced_at           timestamptz;

-- Negative provisioned seats or a negative cost are data errors, not edge cases.
alter table public.subscriptions
  drop constraint if exists subscriptions_vendor_seats_nonneg;
alter table public.subscriptions
  add constraint subscriptions_vendor_seats_nonneg
  check (vendor_seats is null or vendor_seats >= 0);

alter table public.subscriptions
  drop constraint if exists subscriptions_vendor_cost_nonneg;
alter table public.subscriptions
  add constraint subscriptions_vendor_cost_nonneg
  check (vendor_cost_per_seat_month is null or vendor_cost_per_seat_month >= 0);

comment on column public.subscriptions.vendor_seats is
  'Seats the VENDOR has provisioned and bills us for — the "Purchased licenses" column in the Google reseller export. NOT assigned users (that is `used`) and NOT what we bill (that is `seats`). NULL = never reconciled, which is deliberately different from 0.';
comment on column public.subscriptions.vendor_cost_per_seat_month is
  '₹/seat/month the vendor actually charges. Distinct from items.wholesale, which is the price list — the gap between them is a promo that ended or a band we fell out of, and deriving one from the other would make that unobservable.';
comment on column public.subscriptions.vendor_synced_at is
  'When vendor_seats/vendor_cost were last confirmed. A count from four months ago is not a fact about today, and without this a stale reconciliation looks identical to a fresh one.';

-- The leakage view asks "which subscriptions have a vendor count, and how stale?"
create index if not exists subscriptions_vendor_sync_idx
  on public.subscriptions (tenant_id, vendor_synced_at desc nulls last);

commit;
