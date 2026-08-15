-- ============================================================================
-- 0171 — tenant_secrets: version-control catch-up (schema drift fix, CLAUDE.md §17)
--
-- The `tenant_secrets` table (per-tenant API credentials) was created directly
-- in prod by a "migration 0035" that was never committed to this folder — so the
-- base table, its owner-only RLS, and every column EXCEPT the Gemini ones (0070)
-- exist ONLY in prod, not in version control. That is exactly the drift §17
-- forbids: a fresh DB built from these migrations would be missing the table and
-- all the WhatsApp / Razorpay / Sandbox credential columns the app reads.
--
-- This migration re-declares the FULL table idempotently to match prod:
--   • create table if not exists   → no-op on prod, creates it on a fresh DB
--   • add column if not exists      → every credential column (incl. Razorpay)
--   • RLS + owner-only policies      → guarded (drop-if-exists then create)
-- It changes NOTHING on the live database (every object already exists); it just
-- brings the schema under version control so Razorpay + WhatsApp + Sandbox +
-- Gemini credential storage is reproducible.
-- ============================================================================

create table if not exists public.tenant_secrets (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Sandbox (India GST e-invoice / sandbox.co.in) ──
alter table public.tenant_secrets add column if not exists sandbox_api_key    text;
alter table public.tenant_secrets add column if not exists sandbox_api_secret text;
alter table public.tenant_secrets add column if not exists sandbox_api_base   text default 'https://api.sandbox.co.in';

-- ── WhatsApp (Meta Cloud API) ──
alter table public.tenant_secrets add column if not exists whatsapp_provider           text default 'meta';
alter table public.tenant_secrets add column if not exists whatsapp_phone_number_id    text;
alter table public.tenant_secrets add column if not exists whatsapp_access_token       text;
alter table public.tenant_secrets add column if not exists whatsapp_business_account_id text;
alter table public.tenant_secrets add column if not exists whatsapp_app_secret         text;
alter table public.tenant_secrets add column if not exists whatsapp_verify_token       text;

-- ── Razorpay (online payments) ──
alter table public.tenant_secrets add column if not exists razorpay_mode           text default 'test';
alter table public.tenant_secrets add column if not exists razorpay_key_id         text;
alter table public.tenant_secrets add column if not exists razorpay_key_secret     text;
alter table public.tenant_secrets add column if not exists razorpay_webhook_secret text;

-- ── Gemini (AI) — already versioned in 0070; re-declared for a complete snapshot ──
alter table public.tenant_secrets add column if not exists gemini_api_key text;
alter table public.tenant_secrets add column if not exists gemini_model   text;

comment on table public.tenant_secrets is
  'Per-tenant third-party API credentials (Razorpay / WhatsApp / Sandbox / Gemini). PLAINTEXT at rest — protected by owner-only RLS + never returned raw to the client (routes surface masked previews only). Server-side reads use the service-role admin client.';
comment on column public.tenant_secrets.razorpay_key_secret is
  'Razorpay key secret — server-only; never returned raw to the client.';
comment on column public.tenant_secrets.razorpay_webhook_secret is
  'Razorpay webhook signing secret — HMAC-verified in /api/webhooks/razorpay.';

-- ── Owner-only RLS (matches prod exactly) ──
alter table public.tenant_secrets enable row level security;

drop policy if exists tenant_secrets_owner_read   on public.tenant_secrets;
drop policy if exists tenant_secrets_owner_insert on public.tenant_secrets;
drop policy if exists tenant_secrets_owner_write  on public.tenant_secrets;

create policy tenant_secrets_owner_read on public.tenant_secrets
  for select using (
    tenant_id = (select users.tenant_id from public.users where users.id = auth.uid())
    and (select users.role from public.users where users.id = auth.uid()) = 'owner'::user_role
  );

create policy tenant_secrets_owner_insert on public.tenant_secrets
  for insert with check (
    tenant_id = (select users.tenant_id from public.users where users.id = auth.uid())
    and (select users.role from public.users where users.id = auth.uid()) = 'owner'::user_role
  );

create policy tenant_secrets_owner_write on public.tenant_secrets
  for update using (
    tenant_id = (select users.tenant_id from public.users where users.id = auth.uid())
    and (select users.role from public.users where users.id = auth.uid()) = 'owner'::user_role
  ) with check (
    tenant_id = (select users.tenant_id from public.users where users.id = auth.uid())
    and (select users.role from public.users where users.id = auth.uid()) = 'owner'::user_role
  );
