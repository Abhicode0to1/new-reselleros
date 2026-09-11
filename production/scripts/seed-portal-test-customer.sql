-- A portal customer that exists only to TEST the customer panel.
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- Pardeep, 11 Sep 2026: "beside these add a seperate account just for testing
-- with Hosting and Domain Customer panel / those two have admin level and
-- tenant level access".
--
-- The login page's dev box offered two accounts, both STAFF. There was no way
-- in to the customer side except the one demo customer that belongs to a
-- different tenant (rajesh@acmecorp.com, Excel Technologies) and is used as
-- demo DATA elsewhere — including as the recipient in the email tests, where
-- its bounces are expected. Borrowing it for login testing would mean changing
-- rows that other tests read.
--
-- ─── RUN IT ─────────────────────────────────────────────────────────────────
--   cd production
--   npx supabase db query --local -f scripts/seed-portal-test-customer.sql
--
-- ─── THEN SIGN IN AS THE CUSTOMER ───────────────────────────────────────────
--   1. /portal/login  ->  portal-test@anutech.invalid  ->  "Email me a code"
--   2. read the 6-digit code at  http://127.0.0.1:14324   (Supabase's local
--      mail catcher — nothing leaves the machine, and the address is .invalid
--      so there is no real inbox anywhere)
--   3. paste it
--
-- That step used to be explained in a dev-only banner ON the sign-in page.
-- Removed 11 Sep 2026: it was scaffolding on a screen customers see, and this
-- is the file somebody already has open when they set the account up.
--
-- Idempotent: every row is keyed on a fixed fixture UUID and upserted, so
-- re-running refreshes the dates rather than duplicating the customer.
--
-- ─── WHY THIS IS A SCRIPT AND NOT A MIGRATION ───────────────────────────────
-- Migrations run against production. Demo rows in `supabase/migrations/` would
-- put a fake customer, two fake hosting accounts and two fake domains into the
-- real database on the next deploy, where they would appear in revenue reports
-- and in the domain-expiry cron's mail. The project already carries one scar of
-- that shape (a seeded deal that had to be cleaned out by hand), so seed data
-- stays a script somebody runs deliberately.
--
-- ─── THE UUIDs ──────────────────────────────────────────────────────────────
-- `7e57e57e-` is this project's reserved fixture namespace ("testest"), which
-- makes these rows greppable and unmistakable in any dump.
--
-- The suffixes are hex ONLY: the hosting rows read `…a001`/`…a002` rather than
-- the `…h001` I first wrote, because `h` is not a hex digit and Postgres
-- rejects the whole literal — "invalid input syntax for type uuid".
--
-- ─── WHY IT IS ONE `DO` BLOCK ───────────────────────────────────────────────
-- `supabase db query -f` sends the whole file as a single prepared statement,
-- so several top-level statements fail with "cannot insert multiple commands
-- into a prepared statement". A DO block is one statement, and it is atomic —
-- which is what the begin/commit was there for.

do $seed$
declare
  v_exists  boolean;
  v_hosting int;
  v_domains int;
begin

-- ─── The customer ───────────────────────────────────────────────────────────
-- `contact_email` is the ONLY thing the portal login checks: the
-- `portal_customer_exists` RPC matches on it, and `/portal/auth/callback`
-- creates the `customer_users` link on first sign-in. So this row alone is
-- enough to make the account work — no auth user to create by hand.
--
-- The address is deliberately `.invalid` (RFC 2606). It can never be delivered
-- to a real person, and locally that costs nothing: Supabase captures all mail
-- in its own inbox, so the 6-digit code still arrives where you can read it.
insert into customers (
  id, tenant_id, name, contact_email, contact_name, contact_phone,
  city, state, state_code, is_active
)
values (
  '7e57e57e-0000-4000-8000-00000000c001',
  '22222222-2222-2222-2222-222222222222',   -- ANUTECH DIGITAL, the local seed tenant
  'Portal Test Customer',
  'portal-test@anutech.invalid',
  'Portal Tester',
  '+91 99999 00001',
  'New Delhi',
  'Delhi',
  '07',                                      -- Delhi, so GST maths behaves normally
  true
)
on conflict (id) do update set
  name          = excluded.name,
  contact_email = excluded.contact_email,
  tenant_id     = excluded.tenant_id;

-- ─── Hosting: one healthy, one suspended ────────────────────────────────────
-- Two states on purpose. A panel with only healthy rows cannot exercise what
-- was built this week: the suspended row is what the "turn it back on" control
-- and the restore cron act on, and a suspended account is also the only way to
-- see the customer-facing copy for one.
insert into hosting_accounts (
  id, tenant_id, customer_id, domain_name, status,
  plan_code, plan_name, da_username, suspended_at, created_at
)
values
  (
    '7e57e57e-0000-4000-8000-00000000a001',
    '22222222-2222-2222-2222-222222222222',
    '7e57e57e-0000-4000-8000-00000000c001',
    'portaltest-live.in',
    'active',
    'standard', 'Standard', 'ptestliv', null, now() - interval '120 days'
  ),
  (
    '7e57e57e-0000-4000-8000-00000000a002',
    '22222222-2222-2222-2222-222222222222',
    '7e57e57e-0000-4000-8000-00000000c001',
    'portaltest-paused.in',
    'suspended',
    'starter', 'Starter', 'ptestpau', now() - interval '3 days', now() - interval '200 days'
  )
on conflict (id) do update set
  status       = excluded.status,
  plan_code    = excluded.plan_code,
  plan_name    = excluded.plan_name,
  suspended_at = excluded.suspended_at;

-- ─── Domains: one expiring soon, one comfortable ────────────────────────────
-- The 9-day one is the useful fixture. It sits inside the d14 notice step, so
-- the domain-expiry cron has something to warn about and the renewal-quote
-- control has something to price — and because `expires_at` is relative to
-- `now()`, re-running this script keeps it inside the window instead of
-- silently ageing out of it, which is how a fixed date makes a test stop
-- testing anything.
insert into domains (
  id, tenant_id, customer_id, domain_name, tld, status,
  expires_at, auto_renew, registrar, created_at
)
values
  (
    '7e57e57e-0000-4000-8000-00000000d001',
    '22222222-2222-2222-2222-222222222222',
    '7e57e57e-0000-4000-8000-00000000c001',
    'portaltest-expiring.in', '.in', 'active',
    (now() + interval '9 days')::date, true, 'resellerclub', now() - interval '356 days'
  ),
  (
    '7e57e57e-0000-4000-8000-00000000d002',
    '22222222-2222-2222-2222-222222222222',
    '7e57e57e-0000-4000-8000-00000000c001',
    'portaltest-steady.com', '.com', 'active',
    (now() + interval '250 days')::date, true, 'resellerclub', now() - interval '115 days'
  )
on conflict (id) do update set
  status     = excluded.status,
  expires_at = excluded.expires_at,
  auto_renew = excluded.auto_renew;

-- ─── Prove it, rather than trusting the inserts ─────────────────────────────
-- `portal_customer_exists` is the exact gate the login form calls. Asserting on
-- it means this script fails loudly if the RPC ever changes what it matches on,
-- instead of leaving a login button that does nothing — which is precisely how
-- the third entry in the staff dev box rotted (the user it named was not in the
-- database, so clicking it only ever failed).
  select public.portal_customer_exists('portal-test@anutech.invalid') into v_exists;
  if not v_exists then
    raise exception 'portal_customer_exists() says no — the login form would refuse this address';
  end if;

  select count(*) into v_hosting from hosting_accounts
   where customer_id = '7e57e57e-0000-4000-8000-00000000c001';
  select count(*) into v_domains from domains
   where customer_id = '7e57e57e-0000-4000-8000-00000000c001';

  if v_hosting < 2 or v_domains < 2 then
    raise exception 'seed incomplete: % hosting, % domains', v_hosting, v_domains;
  end if;

  raise notice 'portal-test@anutech.invalid ready — % hosting, % domains', v_hosting, v_domains;
end $seed$;
