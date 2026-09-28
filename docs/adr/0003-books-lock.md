# 0003 — Books lock: closed periods are enforced by a database trigger

- **Status:** Accepted (recorded after the fact, 28 Sep 2026)
- **Date:** 2026-09-27 (migration `20260927120000_books_lock.sql`, commit `77dec082`)
- **Decided by:** Pardeep (Accounting); Billing tables included, raised for Abhishek's review
- **Area:** accounting (touches billing tables)

## Context

The accounting audit of 27 Sep (item #16) found nothing stopping an expense, bank line,
salary, tax payment or invoice in an already-filed month — or a past financial year — from
being edited or deleted. Once GSTR-3B / TDS returns are filed, the books for that period
must match what was filed.

## Decision

- `tenants.books_locked_until date` — set by the owner (Accounting → Overview). `NULL` = no lock.
- A `BEFORE INSERT OR UPDATE OR DELETE` trigger, `tg_books_locked(<date column>)`, on every
  money table — expenses, bank transactions, salary, tax and statutory payments, TDS
  receivable, prepaid advances, vendor bills, referral commissions, **and** invoices,
  payments, project payments, credit and debit notes. A lock that leaves invoices open is
  not a lock.
- An UPDATE is checked on both the old and new date, so a row cannot be moved out of a
  locked month.
- The check reads the **JWT role**: `anon` / `authenticated` callers are blocked, including
  through SECURITY DEFINER RPCs they call. `service_role` (crons, webhooks) and direct psql
  sessions are not — deliberately, so migrations and repairs still work.
- In the database, not the UI: every write path (screens, RPCs, API routes, future code)
  gets it for free.

## Consequences

- Correcting a filed period means lifting the lock on purpose, which leaves a trail.
- A cron or webhook that writes a back-dated money row is NOT stopped. Any new service-role
  writer to these tables must respect the lock itself.
- A new money table must be added to the trigger list in a new migration, or it is unlocked.
- The error message is shown to users verbatim, so it says how to proceed (CLAUDE.md §24).

## Alternatives considered

- UI-only check — misses RPCs, imports and API routes.
- RLS policy — SECURITY DEFINER RPCs (most money writes go through them) run as the table
  owner and skip RLS, so the lock would not hold where it matters most.
