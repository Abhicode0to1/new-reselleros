-- 0081_api_keys.sql
-- Per-tenant API keys for the public integration API (/api/v1/*), used by the
-- DSP support platform to read a customer's billing status.
--
-- Security posture:
--   • Only the SHA-256 HASH of the key is stored — never the plaintext. The
--     plaintext is shown to the owner exactly once at creation.
--   • Each key belongs to ONE tenant. /api/v1 auth resolves key → tenant and
--     scopes every query to that tenant (cross-tenant isolation).
--   • Keys are revocable (revoked_at); auth rejects revoked keys.
--   • RLS: a tenant's owners/managers can see their own keys (metadata only —
--     the client never selects key_hash). Lookups by hash happen server-side
--     via the service-role admin client (bypasses RLS).

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  label        text not null,
  key_prefix   text not null,               -- shown in UI, e.g. "ros_live_ab12cd"
  key_hash     text not null unique,        -- sha256 hex of the full key
  scopes       text[] not null default '{read}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_api_keys_tenant on public.api_keys(tenant_id);

alter table public.api_keys enable row level security;

-- Read own-tenant keys (metadata only — key_hash is never selected client-side).
drop policy if exists api_keys_select_own on public.api_keys;
create policy api_keys_select_own on public.api_keys
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- Create/revoke for own tenant. Owner-gate is enforced in the route handler
-- (this policy just guarantees tenant isolation).
drop policy if exists api_keys_insert_own on public.api_keys;
create policy api_keys_insert_own on public.api_keys
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

drop policy if exists api_keys_update_own on public.api_keys;
create policy api_keys_update_own on public.api_keys
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

grant select, insert, update on public.api_keys to authenticated;
