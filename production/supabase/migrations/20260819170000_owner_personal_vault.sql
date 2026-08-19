-- 20260819170000_owner_personal_vault
--
-- The owner's private books: personal bank accounts, money drawn out of the company,
-- household spending, and an investment portfolio. None of it is company data.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE ONE THING TO UNDERSTAND BEFORE CHANGING ANY POLICY IN THIS FILE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Every other table in this schema is scoped `tenant_id = current_tenant_id()`, and for
-- company data that is right: a quote belongs to the business, so everyone in the
-- business may see it.
--
-- **That rule, applied here, would be a data breach.** Measured on production on
-- 19 Aug 2026, the ANUTECH tenant has THREE users with `role = 'owner'`:
--
--     pardeep@anutech.in              Pardeep Sharma        (20 May 2026)
--     info@srigangatechnologies.com   Sriganga Technologies (05 Jun 2026)
--     deepak@anutech.in               Deepak Sharma         (14 Aug 2026)
--
-- A tenant-scoped policy — or a policy that says "owners may read this" — hands one
-- owner's salary, bank balances, household expenses and net worth to the other two.
--
-- All three accounts are legitimate. `info@srigangatechnologies.com` was queried four
-- separate times in TASKS.md as an unidentified owner; Pardeep confirmed on 19 Aug 2026
-- that it is ANUTECH's own address, the same login used for the Google Workspace sales
-- console. That question is closed.
--
-- **It changes nothing here, and it is worth saying why.** The risk was never that one
-- of them might be a stranger. Pardeep and Deepak Sharma are both real, both directors,
-- and both entitled to every row of company data — and neither is entitled to the
-- other's bank balance, household spending or net worth. Personal means one person, not
-- one company. A policy keyed on `role = 'owner'` would be wrong even in a tenant where
-- every owner is family, and the third login makes it wrong twice: a shared console
-- address is an account more than one human can sign into.
--
-- So the rule here is different, and deliberately so:
--
--     tenant_id = current_tenant_id()  AND  owner_user_id = auth.uid()
--
-- The tenant clause is the outer boundary and is kept for consistency with the rest of
-- the schema; **the `auth.uid()` clause is the one doing the work.** Role is not
-- mentioned in any policy below, for two reasons: a role can be changed by another owner
-- (so a role-based grant is revocable by someone else), and being an owner is not the
-- same fact as being *this* person. Whether you may OPEN the feature is a role question,
-- answered by nav.ts. Whose rows you can READ is an identity question, answered here.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY `personal_` AND NOT `vault_`
-- ═══════════════════════════════════════════════════════════════════════════════
-- `vault_passwords` and `vault_access_log` already exist and are a completely unrelated
-- feature — the customers' Google/M365 console credentials this reseller administers.
-- Naming these `vault_accounts` / `vault_transactions` would put two features with
-- opposite audiences under one prefix, and the next person to write a policy "for the
-- vault tables" would get one of them wrong.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY bigint AND NOT integer
-- ═══════════════════════════════════════════════════════════════════════════════
-- Money is whole rupees, as everywhere else in this schema. But the company tables use
-- `integer`, which tops out at 2,147,483,647 — about ₹214 crore. For a single invoice
-- line that ceiling is unreachable. For a personal net worth that includes property it
-- is not obviously unreachable, and an overflow in a net-worth total is a silent wrong
-- number rather than an error. `bigint` costs nothing here.

begin;

-- ─── The screen lock ────────────────────────────────────────────────────────
--
-- Read the comment on `pin_hash` before treating this as security. It is a lock on the
-- screen, not on the data.
create table if not exists public.personal_vault_pin (
  user_id    uuid primary key references public.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  pin_hash   text not null,
  pin_salt   text not null,

  /* Throttling. Four digits is 10,000 possibilities; without a lockout that is a few
     seconds of scripted guessing. */
  failed_attempts int not null default 0 check (failed_attempts >= 0),
  locked_until    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.personal_vault_pin is
  'Optional 4-digit lock on the owner''s private vault screen. One row per user.';
comment on column public.personal_vault_pin.pin_hash is
  'Salted hash of the PIN — the PIN itself is never stored and never leaves the server. BE HONEST ABOUT WHAT THIS PROTECTS: it stops somebody who walks up to an unlocked laptop from reading the screen. It does NOT encrypt the data, and a technically capable person holding a live session can read the same rows straight from PostgREST. The real access control is the RLS policy on each table (owner_user_id = auth.uid()). A 4-digit PIN cannot be more than this: as a key it has 10,000 possibilities, so encrypting under it would be false comfort with the added risk that a forgotten PIN destroys the data.';

-- ─── Personal bank / card / deposit accounts ────────────────────────────────
create table if not exists public.personal_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  /* WHOSE row this is. The whole privacy model hangs off this column. */
  owner_user_id uuid not null references public.users(id) on delete cascade,

  kind  text not null check (kind in ('savings', 'current', 'credit_card', 'fd', 'rd', 'ppf', 'cash', 'wallet')),
  label text not null,
  institution text,

  /* Last 4 digits ONLY, and the check enforces it. A full personal account number in a
     SaaS database buys nothing — you cannot transact from here — and turns a leak of
     this table into a materially worse event. */
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$'),

  /* Whole rupees. For a credit card this is what is OWED, stored positive, and netted
     as a liability by lib/vault/personal/net-worth.ts — storing card debt as a negative
     balance means two places have to remember the sign. */
  balance bigint not null default 0,

  credit_limit  bigint check (credit_limit is null or credit_limit >= 0),
  interest_rate numeric(5,2) check (interest_rate is null or (interest_rate >= 0 and interest_rate <= 100)),
  maturity_date date,

  is_active boolean not null default true,
  notes     text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.personal_accounts is
  'The owner''s OWN bank accounts, cards and deposits — deliberately separate from bank_accounts, which is the company''s and is reconciled against the company''s statements. Mixing them would put personal balances into the company balance sheet.';
comment on column public.personal_accounts.balance is
  'Whole rupees. For credit_card this is the amount OWED, held positive; net worth subtracts it. One sign convention, in one place.';
comment on column public.personal_accounts.account_last4 is
  'Last four digits only, enforced by a CHECK. Enough to tell two HDFC accounts apart, useless to anybody who steals the table.';

-- ─── Drawings from the company, and household spending ─────────────────────
create table if not exists public.personal_transactions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,

  /* Money IN is what the owner took out of the business; money OUT is what they spent.
     Both live here so one screen answers "what came in and where did it go". */
  kind text not null check (kind in ('drawing', 'dividend', 'salary', 'interest', 'other_income', 'expense')),

  category text,
  amount   bigint not null check (amount > 0),
  occurred_on date not null,

  /* Which personal account it hit. Nullable: cash exists. */
  account_id uuid references public.personal_accounts(id) on delete set null,

  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.personal_transactions is
  'Owner drawings / dividends / salary out of the business, and personal household spending. NOT linked to the company ledger: a drawing recorded here does not book anything in the company books, and it must not, or one person''s private note would move the company''s P&L.';
comment on column public.personal_transactions.amount is
  'Whole rupees, always positive. Direction comes from `kind`, so no row can disagree with itself about its own sign.';

-- ─── The investment portfolio ───────────────────────────────────────────────
create table if not exists public.personal_holdings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,

  asset_class text not null check (asset_class in
    ('mutual_fund', 'stock', 'real_estate', 'gold', 'sgb', 'lic', 'ppf', 'epf', 'nps', 'fd', 'bond', 'crypto', 'other')),

  name text not null,

  invested      bigint not null default 0 check (invested >= 0),
  current_value bigint not null default 0 check (current_value >= 0),

  units numeric(20,4),

  /* WHEN current_value was last true. A portfolio total quoted from a value somebody
     typed in March and never revisited is a wrong number wearing today's date, so the
     UI reports how stale each figure is instead of hiding it. */
  valued_on date,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.personal_holdings is
  'The owner''s investments — mutual funds, stocks, property, gold/SGB, LIC, PPF and so on. Values are hand-entered: nothing here is fetched from a market feed, so `valued_on` is what makes the total honest.';
comment on column public.personal_holdings.valued_on is
  'The date current_value was accurate. Null means never marked — the UI must say so rather than implying today.';

-- ─── Indexes ────────────────────────────────────────────────────────────────
-- Every read starts "this person's rows", so every index starts with owner_user_id.
create index if not exists personal_accounts_owner_idx
  on public.personal_accounts (owner_user_id, is_active, kind);

create index if not exists personal_transactions_owner_idx
  on public.personal_transactions (owner_user_id, occurred_on desc);

create index if not exists personal_holdings_owner_idx
  on public.personal_holdings (owner_user_id, asset_class);

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Read the header. `owner_user_id = auth.uid()` is the clause that matters; the tenant
-- clause is the outer boundary. Neither policy mentions a role, on purpose.

alter table public.personal_vault_pin     enable row level security;
alter table public.personal_accounts      enable row level security;
alter table public.personal_transactions  enable row level security;
alter table public.personal_holdings      enable row level security;

/* The PIN row is keyed on user_id rather than owner_user_id — same rule, different
   column name, because here the user IS the primary key. */
drop policy if exists personal_vault_pin_all on public.personal_vault_pin;
create policy personal_vault_pin_all on public.personal_vault_pin
  for all
  using      (user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_accounts_all on public.personal_accounts;
create policy personal_accounts_all on public.personal_accounts
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_transactions_all on public.personal_transactions;
create policy personal_transactions_all on public.personal_transactions
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_holdings_all on public.personal_holdings;
create policy personal_holdings_all on public.personal_holdings
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

/* `for all` covers select / insert / update / delete with one expression each way.
   Four separate policies saying the same sentence is four chances to write it
   differently — and on this table a difference between the SELECT rule and the UPDATE
   rule is one owner editing another's holdings. */

commit;

-- ─── VERIFY (separate run — CLAUDE.md §25.6) ────────────────────────────────
-- select count(*) = 4 as tables_ok from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('personal_vault_pin','personal_accounts','personal_transactions','personal_holdings');
--
-- -- Every policy must mention auth.uid(); a tenant-only policy here is the breach.
-- select tablename, policyname, qual
--   from pg_policies
--  where schemaname = 'public' and tablename like 'personal_%';
--
-- The behavioural proof — that a second OWNER in the same tenant reads zero rows — is
-- supabase/tests/personal_vault_owner_isolation.test.sql, and it is the one that counts.
