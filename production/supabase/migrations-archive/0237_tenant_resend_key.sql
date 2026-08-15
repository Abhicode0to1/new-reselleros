-- 0237 — per-tenant Resend API key + sending identity
--
-- WHY
-- ---
-- Outbound mail currently reads one deployment-wide RESEND_API_KEY environment
-- variable. Every tenant therefore sends through a single Resend account:
--
--   • one bill, with no way to see which tenant spent it
--   • one domain reputation — one tenant's spam complaints degrade delivery for
--     everyone else on the platform
--   • one API key that cannot be revoked for a single tenant
--
-- Storing it per tenant fixes all three. The column is encrypted by the existing
-- envelope (see lib/crypto/tenant-secrets.ts, where it is listed in
-- SECRET_COLUMNS) — nothing here stores a key in the clear.
--
-- NOT A BREAKING CHANGE: the send path falls back to the env var when a tenant
-- has not set their own, so existing behaviour is unchanged until a tenant opts
-- in. A migration that silently stopped all outbound mail until every tenant
-- pasted a key would be a very expensive way to be correct.
--
-- ⚠️  RUN THE DDL ALONE. Do not paste a verification SELECT into the same run —
-- the editor executes a pasted script as ONE transaction, so the SELECT would
-- see the new columns and report success for a change that is about to roll
-- back. Verify in a SEPARATE run.

begin;

alter table public.tenant_secrets
  add column if not exists resend_api_key text;

comment on column public.tenant_secrets.resend_api_key is
  'Tenant''s own Resend API key, envelope-encrypted (rosv1:). NULL = fall back to the deployment-wide RESEND_API_KEY. Listed in SECRET_COLUMNS so it is never returned to a browser in the clear.';

-- The From: address Resend sends as. Not a secret, so it lives on `tenants`
-- rather than `tenant_secrets` — and it is separate from the key because a
-- tenant can hold a valid key and still have an unverified domain, which is the
-- single most common reason mail silently stops.
alter table public.tenants
  add column if not exists email_from_address text,
  add column if not exists email_from_name text;

comment on column public.tenants.email_from_address is
  'From: address for outbound mail, e.g. billing@exceltechnologies.in. Must be on a domain verified in that tenant''s own Resend account, or Resend rejects the send.';

commit;
