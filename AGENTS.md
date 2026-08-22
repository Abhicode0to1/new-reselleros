# AGENTS.md — rules for any AI agent working in this repo

Read this before writing code. It is the short list of things that, if you get them
wrong, cost real money or break a live business.

The long version is `production/CLAUDE.md` (25 sections). This file is the subset that
must not be got wrong, plus the things that are true of this repo *today*. Where the two
disagree, **this file wins** — CLAUDE.md has been wrong before, see §1.

Two agents work here: **Claude Code** and **Antigravity**. Both read this file. Keeping
one rulebook is the point of it existing.

---

## 0. What this is

ResellerOS — a multi-tenant SaaS for Indian cloud resellers (Google Workspace, Microsoft
365, Zoho). Owner: **ANUTECH DIGITAL PVT LTD**, tenant `fbb976f1-9090-4f10-9726-0901bd144e42`.

**It is a live business system.** Wrong numbers here become wrong invoices sent to real
customers. Prefer being slow and right.

- App code: `production/`
- Migrations: `production/supabase/migrations/`
- SQL regression tests: `production/supabase/tests/` (not in CI — run by hand)

---

## 1. ⚠️ MONEY IS STORED IN WHOLE RUPEES, NOT PAISE

This is the one that will bite you hardest, because the docs used to say the opposite.

```
items."Google Workspace Business Starter"  →  msrp = 270,  wholesale = 110
```

That is **₹270** and **₹110** per seat per month — the real Google list and partner
prices. As paise they would be ₹2.70 and ₹1.10, which is not a price for anything.

- `rupee(490644)` → `"₹4,90,644"`. It takes **rupees**.
- `rupeeFromPaise()` is for genuinely-paise numbers. Almost nothing in this schema is paise.
- **Paise DO appear inside calculations**, deliberately — `lib/subscriptions/proration.ts`
  and `margin.ts` convert to integer paise so a division rounds once instead of drifting,
  then convert back. That is a local unit for arithmetic, not the storage unit.
- Rule of thumb: **if it came out of the database or is going into it, it is rupees.**

`CLAUDE.md:296` said "All money in paise" until 14 Aug 2026, and `utils.ts` said it too.
Both are corrected. If you find any other place claiming paise storage, it is wrong —
fix it, don't work around it.

---

## 2. The pattern behind four separate bugs in this codebase

**A failure converted into a plausible value is worse than the failure.**

Real examples from this repo:

| Code | What it did |
|---|---|
| `.catch(() => ({ users: [] }))` | Rendered the founder's signups page **empty for months**. It looked like "no signups". |
| `?? "resend"` on an email provider | Logged every email as sent via Resend, including ones that were not |
| `useCurrentUser` returning `null` on error | Every user looked logged-out-but-logged-in |
| `annualPerSeat × 0.83` as a cost | A hardcoded 17% margin standing in for the real vendor price. On Business Starter the real cost is ₹110; the guess said ₹224 — **double** |

So: **let it fail loudly, or say the value is unknown.** Never substitute a number that
looks reasonable. `null` + "unknown" beats a confident wrong figure every time. If a
component cannot be computed, the UI must say so — see §7.

---

## 3. Types

- **No `any`. No `@ts-ignore`.** TypeScript is in strict mode. If a type fights you, fix
  the type — an `as any` here was reverted on 14 Aug because it turned a compile-time
  error into a runtime one.
- Import the real union rather than widening to `string` (e.g. `LeadActivityKind`).

---

## 4. Multi-tenancy — every table, every query

- Every table (except `tenants`, `users`) has `tenant_id uuid NOT NULL`.
- **RLS is on for every table.** Policies use `public.current_tenant_id()` — 335 policies
  depend on that one function.
- **Never hardcode a `tenant_id`.** Always derive it from auth.
- **Foreign keys must stay inside tenant boundaries.** `items.id` is a bare primary key, so
  a plain FK to it can point at another tenant's row. Use a composite FK on
  `(tenant_id, id)` — see migration `0248`.
- **Never assume a tenant's name tells you whose it is.** New tenants are auto-named from
  the signer-in's email domain, so a wrongly-created tenant is named *exactly* like the
  company it should have joined. When diagnosing "the app looks empty", check `tenant_id`,
  never the tenant name.

---

## 4a. Getting a database to work against

**Never develop against production.** It holds real customers, real invoices, real money.

There is a staging project — `resellerosv3-staging` (`ixgvlbgmvgaihvudtbwt`, Mumbai). Its
schema is an exact copy of production: 87 tables, 133 functions, 286 policies, 48
triggers, 305 indexes, 1335 columns, 234 foreign keys — verified object-by-object, not
assumed.

To rebuild it, or to build any fresh project:

```bash
cd production
node scripts/rebuild-db.mjs <project-ref>      # refuses to run against production
node scripts/db-compare.mjs ontpnqjoysjgrlsukecm <project-ref>   # must be a clean match
```

**Do not build a database by running the 218 files in supabase/migrations/.** They do not
work from empty — see the header of `scripts/rebuild-db.mjs` for exactly why and which
tables break. That is a known, documented defect, not something to rediscover.

A fresh database comes from `supabase/baseline.sql` + `supabase/baseline-storage.sql`.
Both are committed. The storage file is separate because `supabase db dump --schema
public` silently omits the storage schema, and without it file upload and download fail
while every other check passes.

**The database is SHARED between everyone using staging.** A worktree separates files,
not data. Only one person runs a migration or a data reset at a time, and says so first.

---

## 5. Database changes

- **Never apply a DB change without a versioned migration file** in
  `production/supabase/migrations/`. Schema drift between git and prod has broken this
  project before.
- **Run DDL in small batches**, not a whole file at once. The SQL editor runs a pasted
  script as ONE transaction, so one late failure silently rolls back the parts that
  worked, and the screen shows an error nobody connects to "nothing applied".
- **Never put a verification `SELECT` in the same run as the DDL.** It executes inside the
  same uncommitted transaction, sees the new columns, and reports success for a change
  that is about to disappear. Verify in a **separate** run.
- Tooling: `production/scripts/apply-migration.mjs` applies a file batch-by-batch. It needs
  `begin; … commit;` blocks. A `rollback;` block also works — that is how the SQL tests run.
- **Checking grants: use `pg_proc.proacl` / `pg_class.relacl`.** `information_schema`
  filters by the current role and will confidently tell you a grant is missing when it is
  not. This cost real time on 14 Aug.
- **Document numbers come from the `next_document_number(doc_type)` RPC.** Never generate
  one in JS — no `Math.random()`, no `Date.now()`, no `count(*) + 1`. GST law requires an
  unbroken series.

---

## 6. Dates — the IST trap

`new Date().toISOString().slice(0, 10)` returns **yesterday's date** for any moment before
05:30 IST, because IST is UTC+5:30. The users are in India and reps work early.

This was a live bug: "arrived today" showed nothing and "overdue" silently swallowed
leads due today. Use `localDateISO()` from `lib/leads/outcomes.ts`, which formats from
local date parts.

---

## 7. Errors and blocks must say what to do next (CLAUDE.md §24)

Whenever the app blocks a user, it gives three things:

1. **What happened** — plain language
2. **Why** — the actual reason
3. **What to do next** — with a button or link to that place when one exists

Never a bare "not allowed". This applies to Postgres `raise exception` messages too. If a
guard blocks an action, make sure there is always a reachable way to complete or undo it.

---

## 8. Caching — both Supabase clients pin `cache: "no-store"`

Any new Supabase client must do the same.

- **Server:** Next.js caches GET `fetch()` including Supabase's. Without no-store, `/api/v1`
  served **stale billing status and let revoked API keys authenticate.**
- **Browser:** Supabase REST sends no `Cache-Control` and no `Vary: Origin`, and echoes the
  request Origin into `Access-Control-Allow-Origin`. A response cached on
  `http://localhost:3000` gets replayed to the deployed origin still carrying the localhost
  header, so **every** client query fails CORS and the page dies. The build is fine; the
  cache is poisoned. Only a machine that visits both origins can hit it, which is why it
  never shows up in monitoring and always looks like "the deploy is broken".

---

## 9. "Done" means the test is green

```bash
cd production
npm run typecheck && npm run test && npm run lint
```

Lint **warnings** are acceptable; lint **errors** are not. Current baseline: **3,404 tests
passing across 182 files**, typecheck clean, lint clean, `npm run build` exit 0 (measured
22 Aug 2026 — this line said 1,492 until then, which is §12 happening to this very file).
If your change drops that, it is not done.

- CI runs on **pull requests** and on pushes to `main`. It does **not** run on feature
  branches — on a long-lived branch the local gate is the only gate. This is exactly how
  4 unit tests sat broken for months.
- The 28 SQL tests in `production/supabase/tests/` are **not** in CI. A DB/RPC change means
  running them by hand, or it is not verified.

**Say which kind of verified**, and never blur them:

- **test-verified** — a test asserts it
- **browser-verified** — actually observed in the running app
- **reasoned-only** — inferred from reading code

"Reasoned-only" is a fine answer. Calling it "verified" is not.

---

## 10. Two agents, one repo — how not to clobber each other

On 14 Aug both agents worked in the same folder on the same branch. One commit stripped
140 lines from files the other was mid-edit on, because to the second agent that
half-finished work looked like broken code. Setup now:

| | Claude Code | Antigravity |
|---|---|---|
| Folder | `C:/dev/ResellerOSv3 - Copy` | `C:/dev/ResellerOS-antigravity` |
| Branch | `session/money-spine-hardening-jun1` | `antigravity/work` |
| Dev server | port 3000 | port 3001 |
| Commit author | `testing` | `antigravity` |

Rules:

1. **Work only in your own folder.** They are git worktrees — separate files, shared history.
2. **`npm run typecheck` reports the whole repo.** If you see errors in files you did not
   touch, they belong to the other agent. **Do not "fix" them.** Leave them.
3. **The database is SHARED.** A worktree separates files, not data. A migration applied
   from one folder hits the other immediately. **Only one agent runs a migration or a data
   reset at a time**, and says so first.
4. Ship through a PR: push your branch, open a PR into `main`, let CI go green, merge.

---

## 11. Before you build — check whether it already exists

This repo is large and has grown fast. On 14 Aug a brief asked for six features; four
already existed and two of them were fully wired. Three other components (837 lines) were
found unmounted — and git showed they had been removed **deliberately** for a redesign, so
re-mounting them would have undone someone's decision.

So: **search first, read the git history of anything that looks abandoned, and only then
build.** `git log -S"ComponentName" -- path/to/file` tells you whether something was
removed on purpose.

---

## 12. Docs go stale — code is truth

`docs/PROJECT-KNOWLEDGE.md` claimed 27 migrations when there were 196. Never quote a count,
a module list, or a bug status from a doc — verify it, then cite `file:line`.

**And when you find a doc wrong: fix it in the same session.** Working around a stale doc
leaves the trap armed for the next reader. That rule is why §1 of this file exists.

---

# Learned Guidelines

> One rule per incident, each written the day it cost something. Newest last.

## L1. A scheduled job with no retry and no alert loses a whole unit of work, silently
*22 Aug 2026, from the nightly backup.*

`[cron/backup] sweep failed: JWT issued at future` (20 Aug 18:30 UTC = 21 Aug 00:00 IST).
One attempt, one failure, no retry, no notification. `backup.snapshots` has automated rows
for 17, 18, 19, 20 and 22 Aug and **nothing for the 21st** — one night in six, on a free
plan with no PITR. It was found two days later by reading Cloud Run logs, because nothing
tells anybody.

**The rule:** for any scheduled job, answer all three before calling it done — *what
retries it, who is told when it fails, and how you would notice the failure a week later.*
"It returns 500" is not an answer to any of them. A 500 nobody reads is a silent failure
with extra steps.

**Cloud Scheduler specifically:** a `retryConfig` **without `retryCount` means zero
retries**. Every job in this project was created that way (`scripts/setup-cloud-scheduler.sh`
passes no retry flags), so treat every cron here as one-shot until proven otherwise.

## L2. Classify a failure before retrying it — default to NOT retrying
*22 Aug 2026, same incident.*

The obvious fix is `withRetry(3)`. It is wrong. A missing grant or an unapplied migration
cannot fix itself in four seconds, so retrying it produces the same error fifteen seconds
later, having tripled the load and delayed the only signal anybody gets. That is §2's
"failure converted into a plausible value" wearing a different hat.

**The rule:** retry only failures with a *named* mechanism that a later attempt could
survive — clock skew, a transport blip, lock contention. Anything unrecognised surfaces
immediately. See `lib/backup/sweep-retry.ts` (default-deny, both lists tested) and
`lib/email/gmail-transport.ts` (`retryable: boolean` per failure kind), which is the older
example of the same shape.

Two traps that live in the same list: **"invalid JWT" and "JWT issued at future" both
mention a JWT** and only one is transient, so check the permanent list first. And a
**statement timeout is deliberately permanent** — a job outgrowing its window is a fact the
owner needs, and retrying hides the growth while tripling the load that caused it.

## L3. Do not add a retry to an endpoint that returns non-2xx for PARTIAL success
*22 Aug 2026, the fix that was deliberately not shipped.*

Adding `--max-retry-attempts` to the backup scheduler job looks like the completing half of
L1. It is unsafe here, and the reason generalises. `/api/cron/backup` returns 500 in two
different situations: the sweep failed (nothing written — a retry is free), and the sweep
*partly* succeeded (`result.failed > 0`, some tenants already have tonight's snapshot). Cloud
Scheduler cannot tell those apart; it retries any non-2xx. On the second one, a retry writes
duplicate snapshots for the tenants that already succeeded, and `backup._take` keeps only
the newest 30 per tenant — so the retry **evicts genuine older restore points**. The repair
does more damage than the fault.

**The rule:** before putting a retry in front of anything, ask what the endpoint does when it
half-succeeds. If a second run is not idempotent, make it idempotent *first* — the retry is
not the change, the idempotency is. Retrying inside the handler (where you know nothing was
written) is safe; retrying from outside, where you cannot know, is not.

## L4. Never decide authorization by name substring — and never hardcode a colleague's name to do it
*22 Aug 2026, from `/api/my-advances`.*

That route reads `expenses` with `createAdminClient()`, so **RLS is off** and a plain
JS filter was the only thing between one employee and another's money. The filter was:

```ts
curNameLower.includes(empNameLower) || empNameLower.includes(curNameLower)
```

plus a hardcoded ladder of six colleagues' first names, plus a clause granting anyone
whose *email* contained "sales" every advance named "darshan".

Against the live staff list that is not theoretical. An advance recorded as **"Raj"**
would show to **"Ranjeet Raj"**; one recorded as **"Sharma"** to all five Sharmas in this
tenant. **Surnames are shared — a substring test cannot decide whose money this is.**

**The rules:**
- **A route that uses `createAdminClient()` has no RLS.** Its filter *is* the security
  boundary, so it belongs in a tested module, not inline — see
  `lib/expenses/advance-visibility.ts`.
- **Match whole name tokens, never substrings**, and fail closed: no name on the viewer
  or no name on the record means no match.
- **Never match on a display placeholder.** `vendor_name || "Employee"` must not reach the
  matcher, or every unnamed row belongs to anyone called "Employee" (§2 again).
- **Never hardcode a person's name in a rule.** It matched nothing in the live data, so it
  read as harmless — a standing grant that fires the day the data changes.
- **Check the WRITE side too.** The same route's POST took `advance_id` from the request
  body and never checked whose it was, so any employee could file a claim against a
  colleague's advance — and since the balance is derived by summing linked claims, a
  ₹5,000 claim against a ₹2,000 advance drove someone else's balance to zero. Read-side
  filtering is half a fix.

## L5. An `as any` on a Supabase insert switches off checking for EVERY column in it
*22 Aug 2026, same route.*

`(admin.from("expenses" as any) as any).insert({...})` existed because `ExpenseInsert` was
missing `prepaid_advance_id` — a column `ExpenseRow` has had since migration 0209. The cast
was written to smuggle one field past the compiler, and in doing so it stopped type-checking
the other twelve fields in the same object.

**The rule:** a cast to get one column through is never local to that column. When a type
fights you, **fix the type** — the missing field took one line in
`lib/supabase/database.types.ts`, and the route then type-checked clean with no casts at all.
A missing field in the generated types is a bug in the types, not a reason to opt out of them.

## L6. A config problem is not a server error — one catch-all makes the 5xx log unreadable
*22 Aug 2026, from `/api/whatsapp/send`.*

The route mapped every throw to `502` in a single catch, so a workspace that had simply
not filled in its WhatsApp credentials landed in Cloud Run's **ERROR** bucket:

```
502  [/api/whatsapp/send] failed: WhatsApp credentials are not configured for this
     workspace. Settings → Integrations → WhatsApp Business.
```

Production had **four** 5xx events in the fortnight to 22 Aug 2026, and this was one of
them — a settings page nobody filled in, sitting in the same bucket as a lost nightly
backup. That is the real cost: the error log is the one signal anybody scans, and every
non-error in it makes the next reader trust it less. Finding the backup gap meant reading
past this.

Also: **502 means "retry, the upstream is unwell"** and nothing here would change on a
retry — Meta was never called. The caller cannot fix a 502; it can fix a 409, and the
message already said where to go.

**The rules:**
- **Choose the status by who can fix it.** Tenant configuration → 4xx (this repo uses
  **409** for "your workspace state conflicts with this request" — see
  `api/integrations/email-provider`). A missing *deployment* secret is genuinely ours → 503,
  which is what the cron routes correctly use. Upstream actually failing → 502.
- **`console.error` is for faults.** A config notice is `console.warn`, or the error bucket
  becomes a feed.
- **One catch-all per route is a smell.** Classify, then act — the same shape as L2,
  `lib/whatsapp/send-failure.ts` and `lib/email/gmail-transport.ts`.
- **Do not key the decision on `instanceof` alone.** It stops holding across a re-throw or a
  structured clone while the message survives, and a status code that depends on how the
  error travelled is a status code that will be wrong one day.

## L7. A zero-based isolation assertion must be scoped to the OTHER tenant, not to "everything"
*22 Aug 2026, from running the SQL suite that nothing runs.*

`supabase/tests/sandbox_tenant_isolation.test.sql` now fails with:

```
FAIL 1: a sandbox tester can read 8 customer(s) of the live business
```

**There is no leak.** The assertion is `select count(*) from public.customers` — no tenant
filter — and it then calls whatever it counted "the live business". When the sandbox had zero
customers the count was zero and it passed. The tester has since created 8 of their own, and
the arithmetic settles it: the tester saw exactly **8**, the sandbox tenant owns exactly **8**,
and the live tenant's **26** are not among them. A real leak would have counted 26 or 34.

This file already guards against the opposite mistake — its own notes explain that "0 is also
what a broken session returns", so it reads back things that SHOULD be visible as a control.
The author protected against a session that sees nothing and not against a tenant that
legitimately acquires something.

**The rules:**
- Assert `count(*) where tenant_id = <the other tenant>` = 0. Never bare `count(*)`, and never
  let the message claim a tenant the query never checked.
- **A security test that cries wolf is worse than no test.** The next reader learns to discount
  it, and the day it means something nobody believes it.
- **Run `supabase/tests/` before trusting any sentence of the form "the wall is proven".** Those
  38 files are not in CI and not in the Stop hook, so their claims age silently. Measured today:
  **6 of the 31 runnable files are red**, and none of the six is a live defect —
  one false positive (above), one assertion made stale by a deliberate change the same day
  (`renewal_and_subscription_creation` documents "monthly-flex creates NO subscription", which
  `85a5d67` changed on purpose), one polluted by leftover data, and three not yet triaged.
- **Two conventions live in that folder, and a naive runner mis-reports one of them.** 31 files
  end `rollback;` and exit 0 on success. The other 7 do their work inside `do $$ … end $$` and
  finish with `raise exception 'TESTRESULT >> …'` — the exception IS the rollback, so they exit
  **non-zero when they pass** and their result is in the error text. Do not "fix" one of those by
  deleting the raise: that commits its test rows to production.
- **A duplicate-key failure in an isolation test means a previous run did not roll back.** Check
  for the leftover row before believing the assertion — `hierarchy_peer_isolation` failed today
  on `users_pkey`, and the synthetic user from an earlier run was still in `public.users`.

## L8. A guard proved by a test that nobody runs is a guard you no longer have
*22 Aug 2026, from `zero_amount_guards.test.sql`.*

`supabase/tests/zero_amount_guards.test.sql` asserts bug #27: `record_payment` rejects a
payment against a ₹0 quote (migrations 0060/0061). Run for the first time in a long while, it
fails — and the reason is that **the guard is not in the function any more.**

`record_payment` does have `if p_amount is null or p_amount <= 0 then raise exception 'amount
must be > 0'`, and at a glance that looks like the guard. It is not. It checks the **payment
argument**, not the **quote's total**. Nothing anywhere reads `v_quote.amount` for this, so a
₹5,000 payment against a ₹0 quote goes straight through. The function is 26,000 characters and
has been rewritten repeatedly; the guard was lost in one of those rewrites and the only thing
that would have noticed was a test file outside CI.

Measured before claiming harm: there are **zero** ₹0-amount quotes and zero ₹0 payments in the
database, so this is an exposure, not an incident.

**The rules:**
- **A migration is not evidence a guard exists today.** `0060/0061` applied; the behaviour is
  gone. Before citing any guard, grep the live function body — `pg_get_functiondef` — not the
  migration that introduced it.
- **When a guard's test goes red, do not "fix" the test to match the code.** That silently
  retires the guard and destroys the only record that it was ever wanted. Leave it red, say so
  out loud, and let a human decide whether to restore the guard. Red is the correct state for a
  protection that has gone missing.
- **Two guards with the same shape are not the same guard.** `p_amount <= 0` and
  `quote.amount <= 0` differ by one word and by the entire thing being protected. This is how a
  missing check reads as a present one to anybody skimming.
