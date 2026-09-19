-- Merge brick #5: a system of record for the domains and hosting accounts we own.
--
-- ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
-- Bricks #1–#4 made hosting and domains sellable, put them through the
-- quote → payment → invoice spine, and let a paid order reach the provisioning
-- queue. What none of them added is the thing every one of them assumes: a row
-- that says *this customer owns this domain, it expires on this date, and this
-- is its id at the registrar*.
--
-- Measured 8 Sep 2026, before writing a line of this: across all 78 migrations
-- there is no table whose name contains domain, hosting or dns. The only two
-- that come close — `sync_hosting_catalog` and `sync_domain_catalog` — write
-- CATALOGUE rows (a price list of what can be sold), not owned assets. When the
-- hosting trial provisions a real cPanel account today, the username and the
-- expiry are stamped onto the **`leads`** row
-- (api/public/trial/hosting/confirm/route.ts:74-113). That is why the customer
-- portal has no Domains or Hosting section: there is nothing to list.
--
-- ─── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
-- It does not add a second renewal engine, and the temptation was real.
-- `subscriptions.vendor` ALREADY permits 'domain' and 'hosting' (the enum in
-- baseline.sql), and subscriptions already carry renewal_date, auto_renew,
-- outstanding_amount, renewal_state, reminder_count and the whole dunning
-- ladder. A domain that renews is a subscription that renews; copying those
-- columns here would mean two rows disagreeing about when the money is due, and
-- the one nobody is looking at would be the wrong one.
--
-- So the split is by SOURCE OF TRUTH, not by feature:
--   · `subscriptions`  — what the CUSTOMER owes and when we bill them. Ours.
--   · `domains` / `hosting_accounts` — what the REGISTRAR / SERVER says exists:
--     the order id at ResellerClub, the cPanel username, the nameservers, and
--     `expires_at` as the provider reports it.
--
-- These two dates are supposed to agree. When they do not, that is a real
-- signal — a renewal we billed but never sent upstream, or one the registrar
-- extended and we never invoiced — and it is only visible because they are
-- stored separately. `subscription_id` links them; it is nullable because a
-- domain can exist before its billing does (a migration-in, a freebie bundled
-- with hosting, or the ₹0-with-hosting offer).

-- ─────────────────────────────────────────────────────────────────────────────
-- domains
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.domains (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id)   on delete cascade,
  /* NOT NULL on purpose. An asset with no owner cannot be shown to anybody, and
     a nullable owner is how "we will fill it in later" becomes a permanent
     orphan. The paid path always has a customer by the time it gets here —
     record_payment creates one — so a registration that cannot name its owner
     is a request that should stay queued, not an asset with a hole in it. */
  customer_id  uuid not null references public.customers(id) on delete restrict,

  /* Stored lowercase; the check makes that an invariant rather than a habit,
     because availability, DNS and the registrar all key on the exact string. */
  domain_name  text not null check (domain_name = lower(domain_name) and domain_name <> ''),
  tld          text not null check (tld = lower(tld) and tld <> ''),

  /* The registrar's lifecycle, not our billing status — 'grace' and
     'redemption' are ICANN states with real deadlines and real fees, and
     collapsing them into 'expired' loses the only information that says
     whether the name can still be saved and at what cost. */
  status       text not null default 'pending'
               check (status in ('pending', 'active', 'expiring_soon', 'grace',
                                 'redemption', 'suspended', 'transferred_out',
                                 'failed', 'cancelled')),

  registrar             text not null default 'resellerclub',
  /* ResellerClub's own ids. Nullable until the order actually lands upstream —
     a pending row legitimately has none, and inventing one would make a failed
     registration look complete. */
  registrar_order_id    text,
  registrar_customer_id text,
  registrar_contact_id  text,

  registered_at      timestamptz,
  /* The registrar's expiry. NOT the billing date — see the header. */
  expires_at         timestamptz,
  registration_years smallint check (registration_years between 1 and 10),

  auto_renew         boolean not null default false,
  privacy_protection boolean not null default false,
  /* Registrar-side transfer lock. Default true matches ResellerClub's own
     default for a new registration; a domain that can be transferred away
     without us knowing is the expensive kind of surprise. */
  transfer_lock      boolean not null default true,
  nameservers        text[]  not null default '{}',

  /* The money side, all optional — see the header on why a domain can outlive
     or predate its billing row. quote_id is TEXT to match quotes.id. */
  subscription_id          uuid references public.subscriptions(id)          on delete set null,
  provisioning_request_id  uuid references public.provisioning_requests(id)  on delete set null,
  quote_id                 text,
  /* ₹ whole rupees, as actually paid. Rupees, not paise — AGENTS.md, corrected
     14 Aug 2026 against live data. */
  amount_paid              integer check (amount_paid >= 0),

  /* Renewal-sweep bookkeeping. These are about the UPSTREAM action (send the
     renewal to ResellerClub), not about chasing the customer for money — that
     ladder lives on subscriptions and must not be duplicated here. */
  next_action_at   timestamptz,
  /* Distributed lock. A worker claims a row by stamping a future timestamp;
     null means free. Ported from the DMS pattern (models/Domain.ts), which
     exists because two Cloud Run instances renewed the same domain twice. */
  processing_until timestamptz,

  /* Why the last upstream attempt failed, on the row itself. A short-lived
     Cloud Run worker can be torn down before a fire-and-forget log is
     flushed — DMS learned this the expensive way when a ₹1500 purchase
     stranded with zero error records (their commit 5d79eb7, 7 Sep 2026). */
  last_error      text,
  last_error_at   timestamptz,
  last_synced_at  timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

/* A domain name is unique on the internet, so it must be unique here — across
   tenants, not within one. Two tenants both holding example.com is not a
   tenancy question, it is a bug that has already cost somebody a registration
   fee. Partial on deleted_at so a released name can be re-registered later. */
create unique index if not exists domains_name_unique
  on public.domains (domain_name) where deleted_at is null;

/* The registrar's order id is our idempotency key: a retried registration that
   returns the same order id must not create a second asset row. */
create unique index if not exists domains_registrar_order_unique
  on public.domains (registrar, registrar_order_id)
  where registrar_order_id is not null and deleted_at is null;

create index if not exists domains_customer   on public.domains (customer_id, status) where deleted_at is null;
create index if not exists domains_tenant     on public.domains (tenant_id, expires_at) where deleted_at is null;
create index if not exists domains_expiring   on public.domains (expires_at) where deleted_at is null and status in ('active', 'expiring_soon', 'grace');
create index if not exists domains_due        on public.domains (next_action_at) where next_action_at is not null and deleted_at is null;
create index if not exists domains_unlocked   on public.domains (processing_until) where processing_until is null and deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- hosting_accounts
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.hosting_accounts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id)   on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,

  /* The primary domain the account is built around. Not a FK to domains: a
     customer can host a name registered somewhere else, and refusing that would
     turn every migration-in into a support ticket. */
  domain_name text not null check (domain_name = lower(domain_name) and domain_name <> ''),

  status text not null default 'pending'
         check (status in ('pending', 'active', 'suspended', 'expired',
                           'terminated', 'failed')),

  /* DirectAdmin facts. `da_username` is unique on the SERVER, so it is unique
     here too — a collision means we are about to write into somebody else's
     account. */
  server        text not null default 'directadmin',
  da_username   text,
  da_package    text,
  ip_address    inet,
  nameservers   text[] not null default '{}',
  disk_quota_mb    integer check (disk_quota_mb    >= 0),
  bandwidth_quota_mb integer check (bandwidth_quota_mb >= 0),

  /* Catalogue linkage — which sellable plan this account was bought as. TEXT to
     match how the hosting catalogue keys its plans. */
  plan_code   text,
  plan_name   text,

  is_trial    boolean not null default false,
  /* Trials auto-suspend; the existing cron reads this. Null for paid accounts. */
  trial_ends_at timestamptz,

  started_at   timestamptz,
  /* The server's expiry, same distinction as domains.expires_at. */
  expires_at   timestamptz,
  suspended_at timestamptz,
  auto_renew   boolean not null default false,

  subscription_id         uuid references public.subscriptions(id)         on delete set null,
  provisioning_request_id uuid references public.provisioning_requests(id) on delete set null,
  quote_id                text,
  amount_paid             integer check (amount_paid >= 0),

  next_action_at   timestamptz,
  processing_until timestamptz,

  last_error     text,
  last_error_at  timestamptz,
  /* Which KIND of failure, so the desk can tell "DA was down" (retry) from
     "the username collided nine times" (needs a human). Mirrors DMS's
     lastProvisionOutcome, which was added for exactly that triage. */
  last_error_kind text check (last_error_kind in ('hard_failure', 'collision_exhausted', 'server_unreachable')),
  last_synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists hosting_accounts_da_username_unique
  on public.hosting_accounts (server, da_username)
  where da_username is not null and deleted_at is null;

/* One live hosting account per domain. A second one is either a duplicate
   provision or an upgrade that failed to retire its predecessor; both are worth
   refusing at the database rather than discovering on the server. */
create unique index if not exists hosting_accounts_domain_live_unique
  on public.hosting_accounts (domain_name)
  where deleted_at is null and status in ('pending', 'active', 'suspended');

create index if not exists hosting_accounts_customer on public.hosting_accounts (customer_id, status) where deleted_at is null;
create index if not exists hosting_accounts_tenant   on public.hosting_accounts (tenant_id, expires_at) where deleted_at is null;
create index if not exists hosting_accounts_trial    on public.hosting_accounts (trial_ends_at) where is_trial and deleted_at is null;
create index if not exists hosting_accounts_due      on public.hosting_accounts (next_action_at) where next_action_at is not null and deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- dns_records
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A CACHE of what the DNS provider holds, not the authority. The authority is
-- ResellerClub's or DirectAdmin's zone; this table exists so the portal can
-- render a record list without an upstream round-trip on every page load, and
-- so an edit can be shown as pending while it propagates. `last_synced_at` on
-- the parent domain says how stale it is — a cache that cannot say how old it
-- is will eventually be presented as truth.

create table if not exists public.dns_records (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id)  on delete cascade,
  domain_id uuid not null references public.domains(id)  on delete cascade,

  record_type text not null check (record_type in ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA')),
  /* '@' for the apex, as every DNS UI in the world writes it. */
  host        text not null default '@',
  value       text not null,
  ttl         integer not null default 3600 check (ttl between 60 and 604800),
  /* MX and SRV only. Checked rather than merely documented: a null priority on
     an MX record is a mail outage. */
  priority    integer check (priority >= 0),

  /* The provider's own id for this record, needed to update or delete it
     upstream. Null while an add is still in flight. */
  provider_record_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dns_records drop constraint if exists dns_records_priority_required;
alter table public.dns_records add constraint dns_records_priority_required
  check ((record_type in ('MX', 'SRV')) = (priority is not null));

create index if not exists dns_records_domain on public.dns_records (domain_id, record_type, host);
create unique index if not exists dns_records_provider_unique
  on public.dns_records (domain_id, provider_record_id)
  where provider_record_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists domains_touch          on public.domains;
drop trigger if exists hosting_accounts_touch on public.hosting_accounts;
drop trigger if exists dns_records_touch      on public.dns_records;

create trigger domains_touch          before update on public.domains          for each row execute function public.touch_updated_at();
create trigger hosting_accounts_touch before update on public.hosting_accounts for each row execute function public.touch_updated_at();
create trigger dns_records_touch      before update on public.dns_records      for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three readers, and they are not the same reader:
--   · tenant staff  — everything in their tenant (current_tenant_id()).
--   · portal customer — only their own assets (current_customer_id()).
--   · service_role  — the workers.
--
-- Customers get SELECT and nothing else. No INSERT, no UPDATE, no DELETE —
-- assets are created by provisioning, never by a browser.
--
-- ⚠️ AUTO-RENEW IS NOT CUSTOMER-FACING, AND THAT IS A DECISION, NOT AN OVERSIGHT.
-- This file's first draft shipped a `portal_set_auto_renew` RPC so the portal
-- could offer a toggle. That is precisely what migration **0062** did for
-- subscriptions and what migration **0063** took back the next day, for two
-- reasons that apply here unchanged: there is no stored-card autopay, so an
-- "auto-renew ON" switch promises an auto-charge that cannot happen and earns
-- the customer a suspension; and a silent flip to OFF is churn the reseller
-- never sees. The portal shows renewal mode read-only and routes cancellation
-- through an explicit request.
--
-- Domains raise the stakes rather than lowering them — a lapsed registration is
-- released and can be taken by anybody, which is worse than a lapsed seat — but
-- the answer to that is operator-side auto-renew plus reminders, not a switch in
-- the customer's browser. If real autopay (Razorpay e-mandate, as DMS runs it)
-- is ever wired up, re-opening this is a deliberate money decision with its own
-- migration, not a line added quietly to this one.

alter table public.domains          enable row level security;
alter table public.hosting_accounts enable row level security;
alter table public.dns_records      enable row level security;

-- domains ---------------------------------------------------------------------
drop policy if exists domains_select_staff on public.domains;
create policy domains_select_staff on public.domains
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists domains_write_staff on public.domains;
create policy domains_write_staff on public.domains
  for all to authenticated
  using      (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists domains_select_own_customer on public.domains;
create policy domains_select_own_customer on public.domains
  for select to authenticated
  using (customer_id = public.current_customer_id() and deleted_at is null);

drop policy if exists zzz_service_role_all on public.domains;
create policy zzz_service_role_all on public.domains
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- hosting_accounts ------------------------------------------------------------
drop policy if exists hosting_accounts_select_staff on public.hosting_accounts;
create policy hosting_accounts_select_staff on public.hosting_accounts
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists hosting_accounts_write_staff on public.hosting_accounts;
create policy hosting_accounts_write_staff on public.hosting_accounts
  for all to authenticated
  using      (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists hosting_accounts_select_own_customer on public.hosting_accounts;
create policy hosting_accounts_select_own_customer on public.hosting_accounts
  for select to authenticated
  using (customer_id = public.current_customer_id() and deleted_at is null);

drop policy if exists zzz_service_role_all on public.hosting_accounts;
create policy zzz_service_role_all on public.hosting_accounts
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- dns_records -----------------------------------------------------------------
drop policy if exists dns_records_select_staff on public.dns_records;
create policy dns_records_select_staff on public.dns_records
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists dns_records_write_staff on public.dns_records;
create policy dns_records_write_staff on public.dns_records
  for all to authenticated
  using      (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

/* A customer sees the DNS of a domain they own — the ownership test goes
   through `domains`, so there is exactly one definition of "yours". */
drop policy if exists dns_records_select_own_customer on public.dns_records;
create policy dns_records_select_own_customer on public.dns_records
  for select to authenticated
  using (exists (
    select 1 from public.domains d
    where d.id = dns_records.domain_id
      and d.customer_id = public.current_customer_id()
      and d.deleted_at is null
  ));

drop policy if exists zzz_service_role_all on public.dns_records;
create policy zzz_service_role_all on public.dns_records
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
