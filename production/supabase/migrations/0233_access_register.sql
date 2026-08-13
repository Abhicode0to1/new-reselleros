-- ============================================================================
-- 0233 — Access register: WHICH credentials exist, never what they are
-- ============================================================================
--
-- ─── THERE IS NO COLUMN FOR A SECRET, AND THAT IS THE POINT ──────────────────
-- Asked for a password manager. This is not one, deliberately.
--
-- A vault in this app cannot keep its own promise. `SECRETS_MASTER_KEY` is a
-- server-side environment variable, so anyone holding the Cloud Run environment
-- or the Supabase service-role key can decrypt every row. Bitwarden and 1Password
-- derive the key from the user's master password IN THE BROWSER, so the server
-- stores ciphertext it cannot open — that is zero-knowledge, and it is an
-- architecture, not a feature. Retrofitting it would mean no server-side reads,
-- no admin recovery, no RLS-based team sharing, a separate unlock flow and audited
-- crypto: a product, not a table.
--
-- Worth stating plainly, because it decided the shape of this file: with
-- server-side keys, whoever operates the service can read every stored password.
-- A vault whose operator can read your passwords is not a vault.
--
-- So this table has NO `password`, `secret` or `value` column. The guarantee is
-- structural rather than a promise in a comment — you cannot leak what there is
-- nowhere to put. The remaining hole is a human typing a password into `notes`,
-- which `looksLikeSecret()` in lib/access/credentials.ts flags as CRITICAL.
--
-- ─── WHAT IT ACTUALLY ANSWERS ────────────────────────────────────────────────
-- The question a ten-person reseller has and no password manager answers: who
-- holds the GST portal login, when was the bank password last changed, whose DSC
-- expires next month, and — the one that matters most — is there a live
-- credential whose only named holder has left the business.
--
-- `holder_employee_id` is what makes that last one possible: joined against
-- `employees.is_active`, an orphaned credential surfaces by itself.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ───────────────────────────────────────────
-- One batch at a time; the verify block is a SEPARATE run.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 1 · Table
-- ───────────────────────────────────────────────────────────────────────────
begin;

create table if not exists public.access_credentials (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  -- What it opens. "GST portal", "ICICI corporate banking", "Google Admin".
  label      text not null check (length(btrim(label)) > 0),
  -- Grouping only. Free text rather than an enum so a reseller can add whatever
  -- portal they deal with without a migration.
  kind       text,
  -- Where you log in. Handy, and not a secret.
  login_url  text,
  -- The account identifier — an email or username. NOT a password. It is here
  -- because "which of our four Google accounts is this" is a real question, and
  -- a username alone opens nothing.
  account_ref text,

  -- Who is accountable. `holder_employee_id` links to staff so a departure is
  -- detectable; `holder_name` covers a vendor or an external accountant.
  holder_name        text,
  holder_employee_id uuid references public.employees(id) on delete set null,
  -- How many people can actually get in. 1 = the business is locked out if that
  -- person is unavailable.
  holder_count       smallint check (holder_count is null or holder_count >= 0),

  -- WHERE the secret itself lives: "Bitwarden (Anutech org)", "hardware token in
  -- the office safe", "with Pardeep". This is the field that replaces storing it.
  stored_in  text,

  last_rotated_on date,
  expires_on      date,

  -- Free text. Scanned by looksLikeSecret() before save; a match is reported as a
  -- CRITICAL finding rather than silently accepted.
  notes      text,

  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint access_credentials_label_uniq unique (tenant_id, label)
);

comment on table public.access_credentials is
  'Register of WHICH credentials the business holds — never their values. There is deliberately no column for a secret: with a server-side master key, anyone operating the service could read it. Use Bitwarden or 1Password for the secrets themselves and record their location in `stored_in`.';
comment on column public.access_credentials.account_ref is
  'Username or account email. NOT a password — a username on its own opens nothing.';
comment on column public.access_credentials.stored_in is
  'Where the secret actually lives (password manager, hardware token, a named person). This field is what replaces storing the secret here.';
comment on column public.access_credentials.holder_employee_id is
  'Links the holder to staff so that a credential held by a departed employee surfaces by itself when joined against employees.is_active.';
comment on column public.access_credentials.holder_count is
  'How many people can get in. 1 is a single point of failure, which the register reports.';

-- The register is read as "everything, worst first", and the two date columns
-- drive every date-based finding.
create index if not exists access_credentials_tenant_idx
  on public.access_credentials (tenant_id, label);
create index if not exists access_credentials_expiry_idx
  on public.access_credentials (tenant_id, expires_on)
  where expires_on is not null;

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 2 · RLS
--
-- Isolation runs through public.current_tenant_id(), NOT auth.jwt() — 150 live
-- policies depend on it.
--
-- Read is workspace-wide on purpose: the whole value of a register is that
-- everyone can see who to ask. Nothing sensitive is in here to protect, which is
-- exactly why it was built this way. Write is left to any authenticated member so
-- the person who knows a fact can record it; if that proves too open, tighten it
-- to owner/manager in a later migration rather than guessing now.
-- ───────────────────────────────────────────────────────────────────────────
begin;

alter table public.access_credentials enable row level security;

create policy "access_credentials_select" on public.access_credentials
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "access_credentials_insert" on public.access_credentials
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
create policy "access_credentials_update" on public.access_credentials
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "access_credentials_delete" on public.access_credentials
  for delete to authenticated using (tenant_id = public.current_tenant_id());

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
-- Expect: table = 1 · policies = 4 · rls = 1 · secret-ish columns = 0
-- ============================================================================
/*
select 'table' as thing, count(*) as n
  from information_schema.tables
 where table_schema = 'public' and table_name = 'access_credentials'
union all
select 'policies', count(*) from pg_policies
 where schemaname = 'public' and tablename = 'access_credentials'
union all
select 'rls enabled', count(*) from pg_tables
 where schemaname = 'public' and tablename = 'access_credentials' and rowsecurity
union all
-- The design guarantee, asserted rather than assumed: no column exists that
-- invites a secret to be stored. This must be 0 forever.
select 'secret-ish columns (must be 0)', count(*)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'access_credentials'
   and (column_name like '%password%' or column_name like '%secret%'
        or column_name = 'value' or column_name like '%token%'
        or column_name like '%api_key%');
*/
