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
