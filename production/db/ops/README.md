# Database operations — switching an environment onto the Prisma path

Nothing here runs by itself. Do it on **staging first**, check, then production.
Card R-161 · plan `docs/PLAN-move-off-supabase.md`.

## What changes for the app

| | Old path (still works) | New path |
|---|---|---|
| Who talks to Postgres | PostgREST on the VM | Prisma inside Cloud Run |
| Login role | `authenticator` → `authenticated` | `app_runtime` (web), `app_jobs` (crons) |
| Who the user is | verified Supabase JWT | `set_config('app.user_id'/'app.tenant_id', …, true)` per transaction |
| Turned on by | always | `DATABASE_URL` being set on the service (`src/server/db/flags.ts`) |

Both run side by side. A route moved to Prisma falls back to its old Supabase code while
`DATABASE_URL` is unset, so merging never breaks an environment that is not switched yet.

## One-time steps per environment (Abhishek — server/deploy)

1. **Back up** (Cloud SQL on-demand backup) — the next step rewrites 88 policies and 90 functions.
2. **Create the two logins** as `postgres`, with fresh passwords from the password manager
   (never in git, never in chat):
   ```bash
   psql "<postgres admin url>" -v runtime_pw="'<new>'" -v jobs_pw="'<new>'" -f production/db/ops/10-runtime-roles.sql
   ```
   It refuses to finish if either role could bypass RLS or belongs to anything but `authenticated`.
3. **Tell Prisma the old schema is its baseline** (as `resellersos_migration`, through the Cloud SQL proxy):
   ```bash
   MIGRATE_DATABASE_URL="postgresql://resellersos_migration:<pw>@127.0.0.1:5432/resellersos" npx prisma migrate resolve --applied 0_init
   ```
4. **Check git and the database agree before migrating** — the tenant-context migration copies
   function bodies from git. If production holds a newer body that is not in git, it would be
   overwritten. This must print no differences for the functions the migration touches:
   ```bash
   npx prisma migrate diff --from-url "$MIGRATE_DATABASE_URL" --to-migrations prisma/migrations --script
   ```
   (Prisma does not model functions/policies, so also compare `pg_get_functiondef` for the
   90 functions — `scripts/gen-tenant-context-migration.mjs` against the live DB produces the
   same file if they match: run it with a read-only URL into a temp folder and `diff`.)
5. **Apply**:
   ```bash
   npx prisma migrate deploy
   npx prisma db execute --stdin <<< "notify pgrst, 'reload schema';"
   ```
6. **Run the SQL suite** against that database (`npm run test:sql`) — PostgREST behaviour must
   be unchanged, exactly as it was locally (117/120 before and after; the other 3 need real data).
7. **Secrets** in Secret Manager: `database-url-runtime` (app_runtime), `database-url-jobs`
   (app_jobs). Give `resellersos` only the first. The jobs service (later phase) gets only the second.
8. Set `DATABASE_URL` on the Cloud Run service → moved routes switch to Prisma on the next request.

**Connections:** each Cloud Run instance opens up to `DB_POOL_MAX` connections (pg default 10).
Keep `max instances × DB_POOL_MAX` + PostgREST's pool below Cloud SQL `max_connections`
(check it: `show max_connections;`).

**Undo:** unset `DATABASE_URL` → every moved route is back on Supabase immediately. The
migration itself is additive for the old path (same 117 SQL tests green before and after).

## Every new migration from now on

`supabase/migrations/` is frozen (a test fails on a new file there). Write
`prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`, wrap it in `begin; … commit;`,
use `public.current_user_id()` / `public.current_tenant_id()` — never `auth.uid()` /
`auth.role()` (the isolation suite fails on them). Locally: `npm run db:local` rebuilds the
database from git and applies it; `npm run test:isolation` proves isolation;
`npm run test:isolation:mutation` proves the proof.
