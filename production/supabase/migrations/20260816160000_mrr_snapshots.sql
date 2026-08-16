-- 20260816160000_mrr_snapshots
--
-- WHAT THIS ADDS
--   `mrr_snapshots` — one row per customer per month recording their MRR, and
--   `subscriptions.used_synced_at` so a zero in `used` can be told apart from a
--   never-measured one.
--
-- WHY NRR CANNOT BE COMPUTED WITHOUT THIS
--   Net Revenue Retention is a comparison between two points in time: of the revenue
--   you had, how much do you still have? Nothing in this schema records what MRR WAS.
--   `subscriptions` holds only the current figure, and its updated_at is overwritten
--   by any edit.
--
--   So retention is not "hard to compute" today, it is impossible — and any number a
--   dashboard displayed would be fabricated. This table starts the history. NRR stays
--   honestly unavailable until there are two snapshots, and the UI says "not enough
--   history yet" rather than showing the 100% an empty comparison arithmetically
--   produces.
--
-- WHY THE GRAIN IS CUSTOMER, NOT SUBSCRIPTION
--   A customer who moves from one plan to another has not churned. Snapshotting per
--   subscription would report that as one churn plus one new customer, and NRR would
--   swing wildly on ordinary plan changes. See lib/analytics/retention.ts.
--
-- WHY period IS A DATE AND NOT A timestamptz
--   A snapshot is "where things stood on 1 August", not "at 03:14 UTC". A timestamp
--   invites two snapshots for one month that differ by minutes, and then the
--   comparison depends on which one a query happens to pick.
--
-- WHY used_synced_at IS HERE TOO
--   `used` defaults to 0 and nothing in the app has ever updated it (verified on
--   production: 1 subscription, 10 seats, 0 used). Without a timestamp, "nobody is
--   using these seats" and "nobody has ever looked" are the same value — and the
--   first one is a churn alarm while the second is a blind spot. See
--   lib/subscriptions/utilisation.ts.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) from public.mrr_snapshots;                    -- expect 0
--   select count(*) from public.subscriptions where used_synced_at is not null;  -- expect 0

begin;

create table if not exists public.mrr_snapshots (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  /* First day of the month the snapshot describes. */
  period      date not null,
  /* ₹/month, whole rupees, summed across the customer's active subscriptions. */
  mrr         integer not null,
  /* How many active subscriptions made up that figure — useful for spotting a
     customer whose MRR held steady while their plan mix changed underneath. */
  subscription_count integer not null default 0,
  created_at  timestamptz not null default now(),
  /* One row per customer per month. Re-running the snapshot job updates rather than
     duplicating, so a comparison can never pick between two versions of a month. */
  unique (tenant_id, customer_id, period)
);

comment on table public.mrr_snapshots is
  'Monthly MRR per CUSTOMER. Retention is a comparison between two points and nothing else in this schema records what MRR was, so without this NRR is not hard to compute — it is impossible, and any figure shown would be fabricated.';
comment on column public.mrr_snapshots.customer_id is
  'Grain is deliberately the customer, not the subscription: someone who swaps plans has not churned, and per-subscription grain would report that as a churn plus a new customer.';
comment on column public.mrr_snapshots.period is
  'First day of the month described. A date, not a timestamp — a snapshot is "where things stood on 1 August", and a timestamp invites two versions of one month.';

create index if not exists mrr_snapshots_period_idx
  on public.mrr_snapshots (tenant_id, period desc);

alter table public.mrr_snapshots enable row level security;

drop policy if exists mrr_snapshots_select on public.mrr_snapshots;
create policy mrr_snapshots_select on public.mrr_snapshots
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

-- Written by the monthly cron under the service role only. No insert policy: a
-- client-writable history table is a history anyone can rewrite.

alter table public.subscriptions
  add column if not exists used_synced_at timestamptz;

comment on column public.subscriptions.used_synced_at is
  'When assigned-user count was last confirmed. NULL means `used` has never been measured — and 0-because-unmeasured is a blind spot, while 0-because-measured is a churn alarm. Nothing in the app writes `used` today, so this is NULL everywhere.';

commit;
