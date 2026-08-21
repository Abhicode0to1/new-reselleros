-- ============================================================================
-- 20260821120000 — Web Push subscriptions (one row per DEVICE, not per person)
-- ============================================================================
--
-- ─── WHY THIS TABLE EXISTS ──────────────────────────────────────────────────
-- The app already has an in-app notification panel and an attendance reminder, and
-- both only work while somebody is looking at the screen. The reminder in particular
-- exists to catch a missed check-in, and it is mounted in (app)/layout.tsx — so on a
-- closed phone it never fires, which is precisely when it was needed. A push
-- subscription is what lets the server reach the phone instead of waiting for the
-- phone to come back.
--
-- ─── ENDPOINT IS UNIQUE, AND THAT IS THE WHOLE DESIGN ───────────────────────
-- The browser hands out an `endpoint` URL that identifies ONE browser on ONE device.
-- Re-subscribing (new login, cleared site data, permission re-granted) hands back the
-- same endpoint, so the write must be an UPSERT on it. Without the unique constraint
-- a phone accumulates a row per subscribe call and then receives the same notification
-- three or four times — the fastest way to make someone turn notifications off for
-- good, and it looks like a sending bug rather than a duplicate-row bug.
--
-- ─── RLS IS auth.uid()-SCOPED, NOT ROLE-SCOPED ──────────────────────────────
-- A subscription is a device belonging to a PERSON. Tenant-scoping alone would let one
-- owner enumerate a colleague's devices and push to their phone; role-scoping has the
-- same hole with extra steps. So the policies are `tenant_id = current_tenant_id() and
-- user_id = auth.uid()` — the same reasoning as the Owner Private Vault, and for the
-- same reason: "owner" is a chair, not a person.
--
-- The SEND path runs server-side with the service role and therefore bypasses RLS,
-- which is correct: a cron must be able to push to whoever is due, and it never runs
-- as a browser session.
--
-- ─── DEAD SUBSCRIPTIONS ARE DELETED, NOT MARKED ─────────────────────────────
-- When a push service answers 404 or 410 the subscription is permanently gone (app
-- uninstalled, site data cleared). `failed_at` exists for transient failures worth
-- seeing; a 404/410 is deleted outright, because a table of dead endpoints means every
-- future send retries garbage and the failure count stops meaning anything.

-- Batch 1 — the table and its index.
begin;

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_id       uuid not null references public.users(id)   on delete cascade,
  -- The device. Unique across the whole table: an endpoint belongs to one browser
  -- install, and the same endpoint arriving again is the same device saying hello.
  endpoint      text not null unique,
  -- The two keys the browser gives us, used to encrypt the payload (RFC 8291).
  -- Not secrets of ours — they are the DEVICE's public key material — but they are
  -- still per-person data, hence the RLS above.
  p256dh        text not null,
  auth          text not null,
  -- Which device this is, so a person can tell their phone from their laptop when
  -- turning one off. Free text from the browser; never trusted, only displayed.
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  failed_at     timestamptz,
  failure_reason text
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (tenant_id, user_id);

commit;

-- Batch 2 — RLS and the four policies. Separate batch on purpose (CLAUDE.md §25.6):
-- a failure in a later statement must not roll back the table that already succeeded.
begin;

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select using (tenant_id = current_tenant_id() and user_id = auth.uid());

create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert with check (tenant_id = current_tenant_id() and user_id = auth.uid());

create policy "push_subscriptions_update_own" on public.push_subscriptions
  for update using (tenant_id = current_tenant_id() and user_id = auth.uid())
           with check (tenant_id = current_tenant_id() and user_id = auth.uid());

create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete using (tenant_id = current_tenant_id() and user_id = auth.uid());

comment on table public.push_subscriptions is
  'Web Push endpoints, one row per browser/device. endpoint is unique so re-subscribing updates rather than duplicating. RLS is auth.uid()-scoped: a device belongs to a person, not to a role.';

commit;
