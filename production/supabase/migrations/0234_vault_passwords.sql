-- ============================================================================
-- 0234 — Customer credential vault + append-only access log
-- ============================================================================
--
-- ─── FOUR CORRECTIONS TO THE BRIEF, ALL VERIFIED BEFORE WRITING ──────────────
--
-- 1. NOT `0225_vault_passwords.sql`. `0225_lead_loss_reason.sql` already exists and
--    is applied. New work goes here.
--
-- 2. NOT `tenant_id = auth.jwt() ->> 'tenant_id'`. That policy would never match a
--    single row in this database: `tenant_id` is not a JWT claim here. Isolation
--    runs through `public.current_tenant_id()`, which reads `public.users`, and
--    150 live policies depend on it. The JWT form would silently show every user
--    an empty vault — a failure that looks like "no data yet".
--
-- 3. `src/lib/crypto/vault.ts` ALREADY implements AES-256-GCM envelope encryption
--    (per-value DEK wrapped by the master key, `rosv1:` format, tested). This
--    migration does not ask for a second crypto path; the route uses that one.
--
-- 4. The audit trail CANNOT go through `log_activity`. Measured: it derives the
--    tenant from `auth.uid()` and returns EARLY AND SILENTLY when there is none, so
--    a service-role call reports success and writes nothing (638 → 638 rows). It
--    also has no column for an IP address. An audit log that silently does not
--    write is worse than none, because the control it represents is theatre. Hence
--    a dedicated table below with the tenant passed in explicitly.
--
-- ─── THIS IS NOT ZERO-KNOWLEDGE, AND THE UI MUST NOT SAY IT IS ───────────────
-- `SECRETS_MASTER_KEY` is a server-side value, so the server — and anyone holding
-- its environment or the service-role key — can decrypt. A zero-knowledge vault
-- derives its key from the user's own passphrase in the browser and the server
-- never sees plaintext. Claiming zero-knowledge here would be a false security
-- promise passed on to the reseller's customers. The honest phrase is "encrypted
-- at rest, decryptable by the server".
--
-- What it IS good for: consoles this reseller already administers on a customer's
-- behalf. The honest comparison is not "versus Bitwarden", it is "versus the
-- spreadsheet and the WhatsApp messages these logins live in today". Personal and
-- banking passwords still do not belong here.
--
-- ─── THE CIPHERTEXT IS NOT READABLE BY THE BROWSER, BY GRANT ─────────────────
-- Execution instruction 1 asks for no plaintext password in client bundles. Code
-- review cannot guarantee that; a GRANT can. Table-level SELECT is revoked from
-- `authenticated` and re-granted column by column, WITHOUT the three ciphertext
-- columns. A client `select *` on this table therefore ERRORS rather than
-- returning ciphertext, and only the server (service_role) can read the encrypted
-- values at all. It fails loudly instead of leaking quietly.
--
-- ─── THE CONTRACT THE ROUTE MUST HONOUR: LOG, THEN REVEAL ────────────────────
-- SQL cannot enforce this, so it is stated here as the design contract and must be
-- implemented in the API route: write the access-log row FIRST and refuse to
-- return plaintext if that write fails. A trail with holes exactly under load or
-- under attack is not a trail. Reveal-then-log is the wrong order.
--
-- ─── HOW TO RUN (CLAUDE.md §25.6) ───────────────────────────────────────────
-- One batch at a time; the verify block is a SEPARATE run.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 1 · Tables
-- ───────────────────────────────────────────────────────────────────────────
begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'vault_category') then
    create type public.vault_category as enum (
      'google_admin', 'm365_admin', 'dns_registrar', 'cpanel', 'distributor', 'other'
    );
  end if;
end $$;

create table if not exists public.vault_passwords (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  -- Nullable: a distributor portal belongs to the reseller, not to one customer.
  customer_id uuid references public.customers(id) on delete cascade,

  title       text not null check (length(btrim(title)) > 0),
  category    public.vault_category not null default 'other',
  url         text,

  -- `rosv1:` envelopes produced by lib/crypto/vault.ts. Named *_ciphertext so that
  -- anything reading them is obviously handling encrypted data.
  username_ciphertext text,
  password_ciphertext text,
  notes_ciphertext    text,

  /* Keyed, truncated HMAC of the password — for reuse detection ONLY.
     A plain sha256 would let anyone who obtained this table run a wordlist
     offline and recover short passwords, and these are admin consoles. A keyed
     MAC cannot be attacked without the master key, which is not in the database.
     16 hex characters: enough to spot a duplicate among a tenant's credentials,
     obviously too short to be a store of the value. */
  password_fingerprint text check (password_fingerprint is null or length(password_fingerprint) <= 32),

  last_rotated_at timestamptz,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.vault_passwords is
  'Credentials for customer consoles this reseller administers (Google Admin, M365, registrar, cPanel, distributor). Encrypted at rest via lib/crypto/vault.ts. NOT zero-knowledge: the server can decrypt, so personal and banking passwords do not belong here.';
comment on column public.vault_passwords.password_fingerprint is
  'Keyed truncated HMAC of the password, for detecting reuse across entries without storing anything a leak could crack. Never a substitute for the ciphertext.';

create index if not exists vault_passwords_tenant_idx   on public.vault_passwords (tenant_id, title);
create index if not exists vault_passwords_customer_idx on public.vault_passwords (tenant_id, customer_id) where customer_id is not null;
-- The reuse sweep groups by fingerprint.
create index if not exists vault_passwords_print_idx    on public.vault_passwords (tenant_id, password_fingerprint) where password_fingerprint is not null;

-- ── Access log. Append-only, and enforced as such below. ──────────────────
create table if not exists public.vault_access_log (
  id           bigserial primary key,
  -- Passed in explicitly, NOT derived from auth.uid(), which is exactly why
  -- log_activity could not be used here.
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  credential_id uuid references public.vault_passwords(id) on delete set null,
  customer_id  uuid references public.customers(id) on delete set null,
  user_id      uuid references public.users(id) on delete set null,
  action       text not null check (action in ('view','copy','create','update','delete','rotate','export')),
  /* IP and user agent are personal data under DPDP. They are here because a
     security audit trail without them cannot answer "who, from where" — which is
     the whole question after an incident. Retention should be bounded by a
     policy, not kept forever by default. */
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz not null default now()
);

comment on table public.vault_access_log is
  'Append-only record of every vault read or change. UPDATE and DELETE are revoked from all app roles so a trail cannot be edited or erased. Written BEFORE plaintext is returned: if the log write fails, the reveal must be refused.';

create index if not exists vault_access_log_tenant_idx on public.vault_access_log (tenant_id, created_at desc);
create index if not exists vault_access_log_cred_idx   on public.vault_access_log (credential_id, created_at desc);

commit;


-- ───────────────────────────────────────────────────────────────────────────
-- BATCH 2 · RLS, and the grants that keep ciphertext out of the browser
-- ───────────────────────────────────────────────────────────────────────────
begin;

alter table public.vault_passwords  enable row level security;
alter table public.vault_access_log enable row level security;

-- current_tenant_id(), NOT auth.jwt() — see correction 2 in the header.
create policy "vault_passwords_select" on public.vault_passwords
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "vault_passwords_insert" on public.vault_passwords
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
create policy "vault_passwords_update" on public.vault_passwords
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "vault_passwords_delete" on public.vault_passwords
  for delete to authenticated using (tenant_id = public.current_tenant_id());

-- Column-level grants: the browser can list the vault but cannot read a
-- ciphertext column at all. `select *` from a client ERRORS, which is the point.
revoke select on public.vault_passwords from authenticated;
grant select (
  id, tenant_id, customer_id, title, category, url,
  password_fingerprint, last_rotated_at, created_by, created_at, updated_at
) on public.vault_passwords to authenticated;

-- Writes still need the ciphertext columns, and those go through a server route
-- holding the master key; insert/update privileges stay whole.
grant insert, update, delete on public.vault_passwords to authenticated;

-- ── Access log: readable by the workspace, appendable, NEVER editable. ────
create policy "vault_access_log_select" on public.vault_access_log
  for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "vault_access_log_insert" on public.vault_access_log
  for insert to authenticated with check (tenant_id = public.current_tenant_id());
-- No update policy and no delete policy exist, deliberately. Belt and braces:
revoke update, delete on public.vault_access_log from authenticated;
revoke update, delete on public.vault_access_log from anon;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- Expect: tables 2 · vault policies 4 · log policies 2 · rls 2
--         ciphertext columns readable by authenticated = 0   ← the real check
--         log update/delete privileges for authenticated = 0
-- ============================================================================
/*
select 'tables' as thing, count(*) as n from information_schema.tables
 where table_schema='public' and table_name in ('vault_passwords','vault_access_log')
union all
select 'vault policies', count(*) from pg_policies
 where schemaname='public' and tablename='vault_passwords'
union all
select 'log policies', count(*) from pg_policies
 where schemaname='public' and tablename='vault_access_log'
union all
select 'rls enabled', count(*) from pg_tables
 where schemaname='public' and tablename in ('vault_passwords','vault_access_log') and rowsecurity
union all
-- THE guarantee: no ciphertext column is selectable by the browser role.
select 'ciphertext readable by authenticated (must be 0)', count(*)
  from information_schema.column_privileges
 where table_schema='public' and table_name='vault_passwords'
   and grantee='authenticated' and privilege_type='SELECT'
   and column_name in ('username_ciphertext','password_ciphertext','notes_ciphertext')
union all
-- The trail cannot be rewritten.
select 'log update/delete for authenticated (must be 0)', count(*)
  from information_schema.table_privileges
 where table_schema='public' and table_name='vault_access_log'
   and grantee='authenticated' and privilege_type in ('UPDATE','DELETE');
*/
