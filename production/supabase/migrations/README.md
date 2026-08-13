# Migrations — numbering notes

Read this before "fixing" a gap in the numbering. Every gap here is deliberate.

## Current state (verified against prod 2026-08-12)

Prod's last applied migration is **`0223_roles_billing_delivery`**, and git ends at `0223`.
**git and prod are in sync.** Next new migration = `0224_…`.

## Gap: `0018`–`0039` — not missing files

`0003_freeze_baseline.sql` is an idempotent baseline that consolidates 19 ad-hoc
migrations that were applied straight to prod via Studio/MCP between `0002` and
`0003` and never checked into git. Its own header documents this. Nothing to recover.

## `0224_capture_remaining_drift.sql` — what it is and why

**Not hand-written — generated from the live prod catalog on 2026-08-13.** It captures
**11 tables and 9 functions that existed in prod but that no migration in git creates.**

Found by `npm run backup:check`, which asks "could we rebuild prod from git + a backup?"
The answer was **no**: 6 of those tables held live data, including `contacts` with 58 rows
(ALTERed by 6 migrations, CREATEd by none). Before this file, a fresh DB / CI run /
disaster-recovery restore had nowhere to put them.

The 9 functions matter too — three back triggers created here (so §5 would fail without
them), and two are money-adjacent RPCs the reimbursements feature calls
(`settle_reimbursement`, `delete_reimbursement`). None of the nine overlaps a function
already in git, so nothing gets overwritten.

Generated with `format_type()` rather than `information_schema.data_type`, so enum and
array columns (`text[] default '{}'`) round-trip exactly. Constraints are added in a
separate guarded step *after* all tables, so FK ordering never matters. Everything is
idempotent — applying to prod is a no-op, since the objects are already there.

**Verification:** `npm run backup:check` went from `in prod but NOT in git: 11` to `0`.

> Same class of drift as `0003` and `0146`, and the third time it has had to be cleaned
> up. The read-only MCP config (`.mcp.json`, no `apply_migration` tool) exists so it
> stops happening.

## Removed: `0224_grant_execute_current_customer_id` and `0225_employee_expense_advances`

Both existed in git, neither was ever applied to prod, and **both were deleted on
2026-08-12 rather than applied.** Verified against the live database first — the
objects genuinely did not exist (`to_regclass`, `has_function_privilege`).

**`0224`** granted `EXECUTE` on `current_customer_id()` and `current_tenant_id()`
to `anon` **and `public`**. That directly contradicts `0145_lock_down_rpc_execute.sql`,
which revoked exactly those grants as a **P0 security fix** (Supabase grants EXECUTE
to PUBLIC by default, which had made money RPCs callable with only the anon key).
The grants that actually matter — `EXECUTE` to `authenticated` — were already in
place in prod and verified working, so the portal and RLS were never broken.
**Do not re-add this migration.**

**`0225`** created a table `employee_expense_advances`. It is not needed: the
Employee Advances feature (`lib/queries/advances.ts` → `/my-expenses`,
`/accounting/advances`) deliberately runs on the existing `expenses` table with
`category='Employee Advance Disbursal'` — its file header says
*"for 100% zero-migration compatibility"*. `0225` was an earlier, abandoned design.

It also carried two defects that would have caused real problems if applied:

1. **Money unit** — `disbursed_amount NUMERIC(14,2)` in a codebase where money is
   **integer rupees** everywhere (`expenses.amount`, `customer_credits.amount` are
   both `integer`, verified in prod). The feature writes its amount straight into
   `expenses.amount`, so a NUMERIC→integer hop would invite rounding errors in the
   flow that hands cash to employees.
2. **Tenancy chokepoint bypass** — its RLS policy inlined
   `tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid())` instead of
   `current_tenant_id()`. **150 policies in prod use `current_tenant_id()`.** The
   planned multi-company work changes that one function on purpose, so a table with
   an inlined copy would silently keep single-tenant behaviour while everything else
   switched — the worst kind of bug, because nothing would fail loudly.

**Lesson recorded:** a table name appearing in app code is not proof the app queries
it. All four "references" to `employee_expense_advances` were TanStack Query **cache
keys** (`queryKey: [...]`), not database calls. Check the call shape, not the grep
count — see `docs/UX-AUDIT.md` §6.
