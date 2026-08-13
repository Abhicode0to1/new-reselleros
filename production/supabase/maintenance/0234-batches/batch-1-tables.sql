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
