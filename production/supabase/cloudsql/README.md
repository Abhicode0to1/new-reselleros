# Supabase → Google Cloud SQL migration (Path A: self-host the Supabase stack)

The app is a Supabase application: **1,311 `.from()` + 133 `.rpc()` calls (PostgREST)**
and **213 auth calls + `auth.uid()` in 73 RLS policies (GoTrue)**. There is **no direct
Postgres driver** in the repo. So Cloud SQL alone can't run it — we run Supabase's own
data plane (**PostgREST + GoTrue + Storage**) *on top of* Cloud SQL, and the app changes
by **one env var** (`NEXT_PUBLIC_SUPABASE_URL`) plus swapped API keys.

## Cloud SQL target
- Instance `resellsubsos-prod:asia-southeast1:resellersos-db`, PostgreSQL 17.10
- DB `resellersos`, app role `resellersos_app` (owns the 118 public tables)
- Admin role for DDL: **`postgres`** (`resellersos_app` has no `createrole`)

## State after the `public`-only migration (audited 5 Sep 2026)
| Present | Missing |
|---|---|
| 118 public tables, RLS ON, **159 policies**, **133 SECURITY DEFINER funcs** | `auth` / `storage` schemas |
| `plpgsql`, `gen_random_uuid()` (core) | roles anon/authenticated/service_role/authenticator |
| | `auth.uid()/role()/jwt()` helpers |
| | `auth.users` data (logins) |

Policies reference helper functions (e.g. `current_tenant_id()`) that call `auth.uid()`
**inside** — so once `auth.uid()` exists, all 159 policies + 133 functions work unchanged.

## The one Cloud SQL deviation
Supabase's `service_role` bypasses RLS via the `BYPASSRLS` attribute. **Cloud SQL forbids
BYPASSRLS** (only Google's `cloudsqladmin` is superuser). Reproduced the same effect the
supported way: a permissive `TO service_role USING(true)` policy on every public table
(`01-platform-bootstrap.sql` §6). No ownership change, fully reversible.

## Phases
- **1 — Platform bootstrap** → `01-platform-bootstrap.sql` (run as `postgres`). Roles,
  extensions, `auth`/`storage` schemas, `auth.*` helpers, grants, service_role policies.
- **1b — Auth data** → `pg_dump --schema=auth --schema=storage` from Supabase, restore into
  Cloud SQL so `auth.users` ids match `public.users.id` and existing logins/passwords work.
- **2 — Data plane** → GCE VM running the official `supabase/docker` compose with the
  **external DB = Cloud SQL** (services: kong, auth, rest, storage). Reuse the Supabase
  **JWT secret** so existing tokens/keys stay valid. Configure Google OAuth + SMTP.
- **3 — Repoint app** → `NEXT_PUBLIC_SUPABASE_URL` + anon/service keys (Dockerfile ARG +
  Cloud Run). Keep Supabase live in parallel until tested (owner's instruction).
- **4 — Verify money-spine** → login, tenant isolation (RLS), quote→pay→invoice round trip.

## Running Phase 1 (in Cloud Shell, as `postgres`)
1. Upload `01-platform-bootstrap.sql` to Cloud Shell (terminal ⋮ menu → Upload).
2. Fill the 3 service-role passwords (kept in the untracked secrets note):
   ```bash
   sed -i "s/CHANGE_ME_AUTHENTICATOR/<authenticator_pw>/; s/CHANGE_ME_AUTH_ADMIN/<auth_admin_pw>/; s/CHANGE_ME_STORAGE_ADMIN/<storage_admin_pw>/" 01-platform-bootstrap.sql
   ```
3. Run it:
   ```bash
   gcloud sql connect resellersos-db --user=postgres --database=resellersos --project=resellsubsos-prod
   # at psql:
   \i 01-platform-bootstrap.sql
   ```
   (If the `postgres` password is unknown: `gcloud sql users set-password postgres --instance=resellersos-db --project=resellsubsos-prod --prompt-for-password`.)
4. Read the verification rows at the end — 6 roles, `auth.uid() OK`, 118 service_role policies.

## Secrets (NOT in git)
The 3 role passwords + the JWT secret live in a local untracked note the operator keeps;
Phase 2's PostgREST/GoTrue/Storage config reuses them. Never commit them.
