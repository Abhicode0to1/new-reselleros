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

## L9. `record_payment` has lost TWO guards its tests still prove — check the body, not the migration
*22 Aug 2026, from finishing the triage L8 started.*

`record_payment` is 26,000 characters and has been rewritten repeatedly. Two separate guards
that SQL tests in this repo assert are **no longer in it**, and both were found the same
evening, by running a suite that is in neither CI nor the Stop hook:

| Migration | What the test proves | What the function does today |
|---|---|---|
| 0060/0061 (bug #27) | rejects a payment against a ₹0 quote | only checks `p_amount <= 0` — the payment argument. Nothing reads `v_quote.amount`. |
| 0064/0065 | reuses an existing same-email customer instead of duplicating | inserts a new customer from the lead unconditionally (line ~188). No lookup by `contact_email` at all. |
| 0157 | a one-off quote (`is_one_off`) records the payment but creates NO subscription | **the string `is_one_off` does not appear in the function at all.** A direct invoice gets a subscription like anything else. |

**0157 is the worst of the three, because its path is reachable and its damage is silent.**
`quote-builder.tsx:917` sets `is_one_off: isInvoiceMode ? !invoiceRecurring : false` — so any
non-recurring direct invoice takes it. The spurious subscription then lands in MRR (a one-time
sale counted as recurring revenue) and in the renewal cron, which can send a renewal reminder to
somebody who bought once. Nobody has used the path yet — 0 one-off quotes exist — so it is an
exposure, not an incident, and the test that would have caught it asserted nothing at all: it
ended `raise exception 'TESTRESULT >> %'` with the observed values interpolated and the expected
values in a comment for a human to eyeball.

Neither has caused damage yet, measured: zero ₹0-amount quotes, and 12 emailed customers with
12 distinct emails. But the dedup one has a second edge worth knowing — **23 of 35 customers
have no email at all**, so an email-keyed dedup could never have protected two thirds of them
even when it worked.

**The rules:**
- **One long function is where guards go to die.** Every rewrite of a 26k-character body is a
  chance to drop a four-line check, and nothing fails loudly when one goes. If you touch
  `record_payment`, diff the guard list before and after.
- **Grep the live body, never the migration.** `pg_get_functiondef(p.oid)` is the only honest
  answer to "does this guard exist". A merged migration proves it once existed.
- **A guard-shaped line is not the guard.** `p_amount <= 0` sits where the #27 guard should be
  and protects something else entirely, which is why nobody noticed for months.

## L10. When a tenant-scoped function returns 0, suspect the missing context before the logic
*22 Aug 2026, from two of the eleven red SQL tests.*

Two failures looked like product bugs and were neither:

- `credit_card_liability` → `FAIL: card spend touched the bank (bank=0)`. The bank fixture
  opens at ₹1,00,000, so 0 is not "₹5,000 was wrongly deducted" — it is *no rows found*.
  `bank_account_current_balance` is SECURITY DEFINER and scoped by `current_tenant_id()`, and
  the test sets only `{"role":"service_role"}` with no `sub`, so there is no tenant to scope to.
- `portal_customer_users_no_self_update` → `last_login_at not stamped by RPC`.
  `portal_touch_login` keys off `auth.uid()`, which that session does not supply, so it updated
  zero rows. Note what DID pass in the same file: the exploit updated 0 rows and the
  `customer_id` did not move. **The security half held; only the "does the RPC work" half fell.**

**The rules:**
- **Distinguish "wrong number" from "no rows".** A tenant-scoped function with no tenant
  returns 0, ∅ or NULL — which reads exactly like a computation that went wrong.
- **A test that sets `role` has not set an identity.** `current_tenant_id()` needs a `sub`;
  `auth.uid()` needs a `sub`. Setting the role alone gets you neither.
- **Write the failure message about what the query actually checked** (L7 again). "card spend
  touched the bank" sent me looking at card logic for a value that came from an empty result.

## L11. Seven SQL tests ran against the live tenant's books — a fixture must own its data
*22 Aug 2026.*

Seven of the 38 files in `supabase/tests/` hardcode the production tenant and a production
customer, and create no fixtures of their own:

```sql
v_tenant uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';  -- Anutech Digital
v_cust   uuid := '53db44e6-6e90-4fec-8871-8d2288393a2a';
```

`accrue_referral_commission`, `create_direct_invoice`, `create_direct_invoice_recurring`,
`create_project_direct_invoice`, `generate_invoice_payment_terms`,
`record_payment_billing_cycle_decouple`, `record_payment_one_off_guard`.

They **insert quotes and call `record_payment` inside the real company's books**, and the only
thing that takes it back out is the closing `rollback` or `raise exception`. That is one deleted
line away from test quotes and test payments being permanently in ANUTECH's ledger — and
"delete the raise so the test stops erroring" is a plausible thing for somebody to try (see L7).

They also all broke on 22 Aug for the mundane reason: customer `53db44e6…` was deleted, so every
one of them died on `quotes_customer_id_fkey` before its first assertion. **A test that borrows
live ids is a hostage to whatever the operator did last week** — the same failure as
`hierarchy_peer_isolation` borrowing auth ids (L7) and `sandbox_tenant_isolation` counting live
rows (L7).

**The rules:**
- **A fixture owns its data.** Insert your own tenant, your own customer, your own auth user, with
  literal ids in a reserved-looking range. Never `select … limit 1` from real tables, never a
  hardcoded production id. AGENTS.md §4 already forbids hardcoding a `tenant_id`; this is that
  rule applied to tests, where it is easiest to excuse.
- **Never point a write-path test at the live tenant**, even inside a transaction. Correctness
  should not depend on one keyword at the bottom of the file.

**The rule paid for itself the same day.** Hours after those seven were rewritten, the live
ANUTECH tenant had every transactional table cleared at Pardeep's request — leads, quotes,
payments, invoices, customers, subscriptions and the rest, all to 0. The SQL suite came back
**32/38, byte-identical to before the wipe**: not one test broke. Every one of the seven would
have died on the missing customer id that morning. A fixture that owns its data does not
notice what the operator did to theirs.

- **Report-style tests are not tests.** `raise exception 'TESTRESULT >> %'` with expected values
  in a header comment means a regression prints a slightly different sentence and passes. Assert,
  then finish with a visible `select 'PASS'`.

## L12. A status field must answer the question its name asks
*22 Aug 2026, from `invoice_dunning_log`.*

```ts
status: isEmailConfigured() ? "sent" : "stubbed",
```

`isEmailConfigured()` answers *"is Resend set up on this server"*. The column is called
`status` and is read as *"did this message reach the customer"*. Two different questions, and
the wrong one was cheaper to ask.

The result, on real rows: INV-3BBD-2026-27-0002 (SAHAKAR INFRACON PROJECTS PRIVATE LIMITED,
₹55,885) has a `reminder` step logged on 19 Aug and a `retry` on 21 Aug, both `status = 'sent'`,
both `recipient_email = NULL`. **Nothing was sent** — the route only sends when it has an
address (`if (to && msg)`), and that customer has no `contact_email`.

This is §2 in its most expensive form, because **the wrong value is reassuring**. The reseller
reads "reminder sent, retry sent, still unpaid" and concludes the customer is stalling. The
ladder advances on those rows too, so the invoice marches toward an escalation that says "the
customer has had the full reminder sequence" about somebody who was never contacted. A missing
customer email is an ordinary state; it only needs to be *visible*, because it is the
reseller's to fix and nobody else's.

**The rules:**
- **Log what happened, not what was possible.** Derive a status from the outcome of the action,
  never from the configuration that would have permitted it.
- **Check the specific before the general.** `lib/invoices/dunning-log-status.ts` looks at the
  recipient first and the provider second, because a configured provider says nothing about a
  message with nowhere to go. Getting that order wrong *is* the bug.
- **"Nothing to do" and "done" must not share a value.** They need separate states —
  `no_recipient` here — or the difference is unrecoverable from the audit trail afterwards.
- **Count the silent cases and surface them.** The cron now returns `no_recipient`, so a run
  that reached nobody cannot report itself as a normal night.

## L13. A function whose OUT column shares a name with a table column cannot run
*22 Aug 2026, from `create_project_direct_invoice`.*

```
RETURNS TABLE(invoice_id text, project_id uuid)
...
select id into v_msid from public.project_milestones where project_id = v_pid order by seq limit 1;

ERROR 42702: column reference "project_id" is ambiguous
```

An OUT column is a PL/pgSQL variable inside the body, so `project_id` in that WHERE clause
could be either. Postgres refuses to guess, and it refuses at **runtime**, on every single
call — there is no compile step to catch it. The function aborts after
`create_project_quote` and `accept_project_quote` have already run, so the caller gets an
error naming neither.

**It had never once succeeded.** `project_sales` and `project_milestones` both hold 0 rows,
while `create-project-quote-dialog.tsx:46` has called it through
`useCreateProjectDirectInvoice()` since migration 0160. A whole feature, wired to the UI,
dead the entire time.

**The rules:**
- **Alias every table in a plpgsql function body and qualify every column** — `pm.project_id`,
  never bare `project_id`. Cheap habit; the alternative is a landmine that only goes off in
  production.
- **An OUT column name is taken.** `RETURNS TABLE(... project_id ...)` reserves that word
  for the whole body. Prefix locals (`v_`) — this codebase already does — and treat the OUT
  names as equally dangerous.
- **0 rows in a feature's table is a finding, not a quiet fact.** Both tables being empty was
  the visible symptom for months and read as "nobody uses projects yet".
- **This is what an unrun test costs.** The one file exercising this path had stopped running
  (deleted customer id) and asserted nothing before that. Fixing the test found the bug in a
  single run.

## L14. Read your ids BEFORE `set role authenticated`, or the exploit you test targets NULL
*22 Aug 2026, from `portal_customer_users_no_self_update`.*

That file proved a portal customer cannot re-point their `customer_users` link at another
customer. It had been passing. It was proving nothing:

```sql
set local role authenticated;
do $$ begin
  select auth_user_id::text into v_uid from public.customer_users where customer_id = '…a7';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, …), true);
  update public.customer_users set customer_id = '…a8' where auth_user_id::text = v_uid;
  -- assert 0 rows updated
```

The SELECT runs as `authenticated` with **no claims set yet**. RLS filters it, `v_uid` is
NULL, and the exploit UPDATE becomes `where auth_user_id::text = NULL` — zero rows whatever
the policies say. A green security test over a statement that could never have touched a row.

The symptom that exposed it was the *other* case: `portal_touch_login()` keys off `auth.uid()`
and also did nothing, so `last_login_at` stayed at its seeded 2020 value. That failure is the
only reason anybody looked, and it was the smaller problem by far.

**The rules:**
- **Capture ids before the role switch**, and carry them in a transaction-local GUC —
  `authenticated` can read a GUC but not a temp table owned by the connection role.
  `hierarchy_peer_isolation.test.sql` already documented this; the lesson had not spread.
- **Guard the guard.** A "cannot update / cannot insert" assertion needs a setup check that
  the target row IS reachable as that user first, so "0 rows" means *refused* and not
  *invisible*. This file now asserts `auth.uid()` matches and that the user sees exactly 1 of
  their own rows before trying the exploit — and reverting to the old order makes it say
  `SETUP FAIL: … would match no rows and prove nothing` instead of passing.
- **Suspect any security test whose every number is 0.** That is the shape both this and
  `sandbox_tenant_isolation` failed in, in two different ways (L7).

## L15. There is no forgot-password page, and a destructive screen demands the password
*22 Aug 2026, from Pardeep trying to use Settings → Reset data.*

`src/app/(auth)/` contains `login`, `signup`, `callback` and `welcome`. **There is no
forgot-password or reset-password route anywhere in the app.**

That collides with a real screen: Settings → Reset data requires the operator's login
password, and the API re-checks it with `signInWithPassword`. So the owner of the business
could not use it — measured on the live account, `pardeep@anutech.in` has
`providers = 'email, google'`, meaning he normally signs in with Google and has no reason to
remember the password that exists on the row.

The only way out is the Supabase dashboard (Authentication → Users → ⋯ → send recovery, or
set a new password), which is not something the app tells anybody.

**The rules:**
- **Password recovery is not optional once anything asks for a password.** Any screen that
  demands re-authentication needs a reachable way to recover that credential — otherwise the
  guard is a locked door with the key thrown away (CLAUDE.md §24: never a dead end).
- **Check the auth providers before assuming a password is known.** A Google-first account has
  a password row it has never used. `auth.identities.provider` is where that shows.
- **Do not weaken the guard to work around it.** The password check on that screen is
  protecting a delete that takes 39 payments and 26 lead activities along with the six
  sections it names. The fix is a recovery route, not a softer gate.

## L16. `grid-flow-col` on top of an unreset `grid-cols-N` renders columns at ZERO width
*22 Aug 2026, from the Kanban board on /leads.*

Reported as *"canban view sahi show nahi ho raha hai"*. The board carried:

```
grid-cols-1 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-[minmax(220px,1fr)]
```

Measured in the browser at a 1051px viewport:

```
grid-template-columns: 0px 0px 220px 220px 220px 220px
```

**New (9 leads) and Contacted (26) were the two 0px tracks** — 35 of 37 deals with no width
to render in, under a footer reading "37 total deals visible". Three empty columns on screen
and a count of 37 beneath them.

The mechanism: `sm:grid-cols-2` is an **explicit** template and nothing reset it at `lg`. With
`grid-auto-flow: column`, items 1–2 fill those explicit tracks and 3–6 create **implicit**
ones — and `grid-auto-columns` applies *only to implicit tracks*. The four implicit columns
took 4×220px of a 779px container, so the explicit pair's `1fr` resolved to 0. Adding
`lg:grid-cols-none` makes all six implicit: `220px ×6`, scrollWidth 1380, and the board
scrolls as designed.

**The rules:**
- **Reset the template wherever you switch to `grid-flow-col`.** `grid-cols-none` at that
  breakpoint, every time. A responsive `grid-cols-N` lower down does not stop applying just
  because a later breakpoint adds column flow.
- **`grid-auto-columns` never touches explicit tracks.** If some columns obey your minimum and
  others do not, that is the tell.
- **A zero-width grid track is invisible, not broken-looking.** No error, no overflow, no gap —
  the cards simply are not there, which reads as "no data" rather than "bad layout".
- **jsdom cannot catch this**, so a rendering test is no help: it does not do grid layout, and
  the columns measure identically before and after. `lib/ui/grid-flow-col-reset.test.ts` scans
  the source for the class combination instead — the same approach as `route-map.test.ts`, with
  a guard that it actually scanned 100+ files.

## L17. An API field the UI never sends is a feature that does not exist
*22 Aug 2026, from "email sales@anutech.in se jani chahiye".*

`PATCH /api/integrations/email-provider` has accepted `gmailSenderUserId` all along, and
validates it properly — it refuses an account with no refresh token, refuses one that never
granted `gmail.send`, and returns a §24 message with a `next` link for each. Everything
needed to choose a different sending account was there.

`email-sending-card.tsx` never sent the field. So the sender was whoever configured email
FIRST, because PATCH derives it as `body.gmailSenderUserId || current || the caller's id`.
Pardeep set it up, so every email left as `pardeep@anutech.in`, and no screen in the app
could change it. From the outside this looks exactly like a missing feature; in the code it
looks finished.

**The rules:**
- **A validated parameter with no caller is dead weight that reads as capability.** When
  reviewing "does the app support X", check the call site, not the handler. `grep` for the
  field name and see whether anything sends it.
- **Defaulting an identity to "whoever is asking" outlives the request.** `|| user.id` is
  reasonable for a first save and wrong forever after — it silently makes a config decision
  that nobody chose and nobody can see.
- **List the ineligible options, do not hide them.** "sales@ is not in the picker" and
  "sales@ has not connected Google" send someone to different places, and only the second
  was true. The row is shown, disabled, with what is missing and who has to fix it.
- **Show the address mail actually leaves from.** A workspace login of sales@anutech.in
  connected to a personal Gmail sends from the personal one. Displaying the login would
  hide from the operator what the customer sees in From.

## L18. A `redirectTo` that is not allowlisted is discarded in silence, and Site URL takes over
*22 Aug 2026, from the first real password-reset link.*

`/forgot-password` sends
`redirectTo: ${origin}/callback?next=/reset-password`, and `appPathOr` accepts
`/reset-password` — the app-side chain is correct and was verified. Clicking the link still
landed on the **marketing landing page**, at
`resellersos-1005662057478.asia-south1.run.app` with no path, no `code`, no query.

That is Supabase Auth falling back to **Site URL**: when `redirectTo` is not in the
project's Redirect URLs allowlist it is ignored, and nothing anywhere reports it. Not an
error, not a warning, not a different landing page — the operator simply arrives somewhere
that looks like the app failed.

**Two hosts serve this Cloud Run service and both are real** —
`resellersos-njvk4nxhdq-el.a.run.app` (what `gcloud run services describe` returns) and
`resellersos-1005662057478.asia-south1.run.app` (what the Cloud Scheduler jobs call). An
allowlist holding one of them breaks every flow started from the other.

**The rules:**
- **Any OAuth or magic-link `redirectTo` needs its origin in the allowlist**, with a path
  wildcard: `https://<host>/**`. Add every host that serves the app, plus
  `http://localhost:3000/**` for development.
- **Do not debug this in the app first.** The give-away is a landing URL with no `code`
  parameter: the callback was never reached, so no amount of reading the callback route
  explains it. Check the allowlist before the code.
- **The service having more than one hostname is the part that surprises people.** Grep for
  hardcoded hosts (`scripts/setup-cloud-scheduler.sh` pins one, docs pin the other) before
  assuming there is a single canonical origin.

## L19. Supabase Auth still emails under a brand this company retired
*22 Aug 2026, same email.*

The password-reset mail arrives as:

```
Excel Technologies <no-reply@mail.exceltechnologies.in>
```

**Excel Technologies is historical.** The company is ANUTECH DIGITAL PVT LTD
(`CLAUDE.md §1`, corrected 14 Aug 2026 after the same name was found in `doc_code`, the
dev-login list, and the docs). Auth email is one more place it survived — and the worst
one, because it is the only branding a *teammate or customer* sees before they trust a link
enough to click it. A reset mail from a company they have never heard of is a mail they
should ignore.

**The rules:**
- **Auth emails are branding, not plumbing.** They are sent by Supabase, so they are invisible
  to every grep of this repo and survive every rename done in code. Check
  Authentication → Emails / SMTP whenever the company name changes.
- **When correcting a historical name, list the places it can hide**: `doc_code`, seeded demo
  data, docs, and anything a third-party service sends on your behalf. §1 caught the first
  three; this is the fourth.

## L20. A hardcoded recipient is a data leak, not a stale string
*22 Aug 2026, found in five routes while reading an unrelated log line.*

Five server routes carried `const PARDEEP_EMAIL = "Pardeep@exceltechnologies.in"` and used it
as `to:` / `replyTo:`. `api/webhooks/razorpay/route.ts` had been fixed months earlier and its
own header states the cost — *"every tenant's payment alert, carrying their customer's name,
email and amount, was mailed to one fixed address. The owner of the tenant that made the sale
never got it, and someone else did."* The other four kept the bug, and one of them,
`api/cron/trial-expiry`, **SELECTS `tenant_id` for every expired trial and never reads it.**

Two things make this class hard to see:

- **It never looks broken.** A misdirected alert is delivered, so nothing errors, nothing
  retries, no log line appears. A *missing* alert eventually gets noticed; a misdirected one
  does not. That inverts the usual instinct — here, refusing to send is the safer failure.
- **The comment tells you it is temporary and nobody re-reads comments.** The enquiry route
  said, in full: *"Hardcoded for v1 (single tenant); resolve per-tenant once we go
  multi-tenant."* That TODO came due and no test, type, or lint rule was watching it.

**The rules:**
- **Resolve every recipient from data, never from a constant.** `lib/email/owner-alert.ts`
  returns an address or a *stated reason* — there is no fallback constant to leak, the same
  posture as `lib/invoices/supplier-identity.ts` ("never invent a tax identity").
- **A fallback recipient is the bug with better manners.** The razorpay route's
  `seller.email || FALLBACK_OWNER_EMAIL` was defended in its comment as better than "silently
  dropping" the alert. It was not dropping it — it was delivering another tenant's customer
  data to a third party. Deleted, not improved.
- **Guard the SHAPE, not the string.** The obvious test is
  `expect(src).not.toMatch(/exceltechnologies/)`, which `lib/whatsapp.test.ts` does for
  signatures. Wrong tool here: one live tenant legitimately *has* that address on file, and a
  brand-dated guard passes the day somebody hardcodes `pardeep@anutech.in` instead — the same
  bug with a fresher domain. `lib/email/no-hardcoded-recipient.test.ts` scans for *a literal
  at a recipient field*, so it fails on an address nobody has thought of yet.
- **A shape guard has a blind spot, and you must go fix what it cannot see.** The razorpay
  fallback reached `to:` through a variable, so the scan showed that route clean while the
  other four looked guilty. Green there was luck. Grep the same idea by hand once, then
  remove what the guard cannot reach rather than trusting the pass.
- **The same audit finds hardcoded IDENTITY, not just hardcoded addressing.** Those routes
  also told every customer that "Pardeep will WhatsApp you", gave one fixed phone number,
  and signed off *"Google Premier Partner · since 2014"* — a certification claim asserted on
  behalf of whichever tenant owns the storefront. Check the message body, not only the
  headers.

## L21. `x && sendEmail(...)` inside Promise.allSettled makes "not sent" read as "sent fine"
*22 Aug 2026, introduced by the L20 fix and caught before it shipped.*

Guarding a send as `owner.ok && sendEmail({...})` is the natural way to skip it. But
`Promise.allSettled` settles the literal `false` as `{ status: "fulfilled", value: false }`,
and the handlers below all read `r.value.status === "failed"`. On a skipped send that is
`undefined` — falsy — so the skip is silently classified as a success. No throw, no log, and
the counter that was supposed to prove the mail went out counts it.

**The rule:** when a conditional send sits in an `allSettled` array, check the value is a
result before reading it as one (`r.value && r.value.status === "failed"`). Same family as the
dunning-log defect: a log that reports a send nobody made is worse than no log, because it is
the thing you will trust later.

## L22. A template fed a stale snapshot reads as unread mail
*22 Aug 2026, reported from the lead drawer with a screenshot.*

The thread was: we wrote "your enquiry for 50 users of Business Starter"; the customer
replied "actually I need 20 users of Business **Standard**, not 50 of Starter". The
"Quote is on the way" pill then filled the composer with **"Thank you for your enquiry for
50 users of Google Workspace Business Starter … If the number of users changes before then,
just reply here and I will adjust it."**

Both sentences are wrong in the same way: it restated the figures the customer had just
corrected, then invited them to do the thing they had just done. Not a badly-written
template — a correct template fed a stale snapshot. `PillContext.seats`/`.product` come from
the LEAD row, which records the FIRST enquiry, and nothing told the pill a newer message
existed.

The module already held the principle it needed. It hides the "Ask for phone number" pill
when a number is on file, because — its own words — *"a button that asks a customer for
something already on file makes the reseller look like they did not read the email."*
Restating superseded seats is that failure exactly; the reasoning was written down and not
carried across.

**The rules:**
- **A record built from an event is a snapshot, not the current truth.** Any field copied
  out of the first contact (seats, product, budget, timeline) must be treated as possibly
  overtaken the moment a newer message exists. Ask "what is the newest thing the customer
  said?" before restating anything back to them.
- **When facts may be stale, stop asserting them — do not guess the new ones.** The reply
  said 20 of Standard; a template cannot parse that and must not pretend to. Dropping the
  clause is honest, a guessed seat count in a customer's inbox is not. Same rule as
  `whatTheyAskedFor`: "or nothing, never a guess."
- **The stale/fresh distinction needs BOTH halves.** "Newest message is inbound" is not
  enough — a first enquiry is also inbound-newest, and there the stored facts are exactly
  right to repeat back. `summariseThread().customerRepliedToUs` requires an inbound newest
  AND at least one outbound before it.
- **Reading a correction and acting on it is a model's job, not a template's.** The honest
  ceiling for a canned reply is to acknowledge that something changed. If the product needs
  to answer "they cut it to 20 Standard, here is the revised quote", that is an LLM reading
  the thread, and it needs the money-guard that `api/ai/draft-followup` already has.

## L23. Check what "pass" means before believing a test count
*22 Aug 2026, Phase 0 of automating the spine.*

I built a runner for the 38 files in `supabase/tests/` and it reported **12 pass / 26 fail**.
Twenty of those failures said "exit 0, no PASS row". I almost reported 26 failures.

The detector was wrong, not the suite. These tests signal success with
`raise notice 'PASS: …'` — a NOTICE, which the CLI's JSON output does not carry at all. A
real failure `raise exception`s, which exits non-zero. So the correct criterion is the exit
code, and the honest count is **32 pass / 6 fail**.

**The rule:** before reporting a test count, run one test you believe PASSES and one you
believe FAILS, and confirm the detector separates them. A pass-detector that looks for
evidence of success will read a silent success as a failure — and unlike the usual vacuous
test, this one fails LOUD and sends you fixing things that were never broken. Twenty
invented failures in the money spine is a full day spent, and it would have ended with a
"fix" to code that was correct.

Corollary, from the same run: **a suspiciously large number of failures is itself evidence
about the harness, not the code.** Twenty simultaneous regressions in one folder is a less
likely story than one wrong grep.

## L24. Verify a DDL fix in a rolled-back transaction, and inject it after EVERY `begin;`
*22 Aug 2026, same work.*

DDL is transactional in Postgres, so a 26 KB `CREATE OR REPLACE FUNCTION` can be applied
inside a test's own transaction, asserted against, and rolled back — proving a fix against
production data without persisting a byte. That is how the three `record_payment` guards were
confirmed as 32/38 → 36/38 with zero regressions before anything was applied.

Two things that make the difference between proof and theatre:

- **Inject after every `begin;`, not the first one.** Several files here run more than one
  transaction (`zero_amount_guards` has two). Patch only the first and the later sections run
  against the UNPATCHED function while the file still reports green — the regression check
  silently covers less than it claims.
- **Run the WHOLE suite, not just the tests you meant to fix.** The four target tests going
  green says nothing about the other 34, and the change was to the function at the centre of
  the spine. "Zero regressions" is a measurement, not an expectation.

And when merging several test files into one transaction to save time, don't: fixture ids
collide (`cccccccc-…d1` is used by two of these), and the collision reads as a failure of the
fix. One transaction per file.

## L25. "The data is slow" is usually "the screen never refetches" — check the last hop first
*22 Aug 2026, reported as "email receive me bahut time lagta hai, real time nahi ho sakta?"*

The instinct is to go looking at ingestion: is the webhook slow, is Gmail forwarding lagging,
should we poll the Gmail API. All of that was fine. Inbound mail is PUSHED —
customer → Gmail → forwarding rule → inbound-parse provider →
`POST /api/webhooks/inbound-email` → `inbound_emails` — and every hop to the database takes
seconds.

The delay was entirely the last arrow, the one nobody counts as a hop. `useInboundEmails()`
declared no `refetchInterval`; `query-provider.tsx` sets `refetchOnWindowFocus: false` for the
whole app; `staleTime` is 30s. So once the page was open, a new email could sit in the
database **indefinitely** and never appear. The only remedy was a hard reload.

**The rules:**
- **Walk the chain backwards from the eyeball, not forwards from the source.** The render is a
  hop. It is the cheapest one to check and the easiest one to forget, because every other hop
  has a log line and this one has none.
- **A global default that is right for the app can be wrong for one screen.** That comment —
  "refetchOnWindowFocus: disabled (annoying for SaaS apps)" — is correct for a settings page
  and exactly backwards for an inbox, where the commonest motion is reading mail in Gmail then
  switching tabs to see it. Override locally; do not flip the global.
- **A poll with the default `staleTime` can still show nothing new.** The refetch is answered
  from cache. `refetchInterval` without `staleTime: 0` is the same bug wearing a shorter delay.
- **Look at what the neighbours do.** `lib/queries/whatsapp.ts` already polled at 10-15s and
  `useNavBadges` at 60s. Inbound email — the one surface with a customer waiting at the other
  end — had nothing. An inconsistency across sibling modules is a defect report sitting in the
  codebase for free.
- **The missing column is why it stayed unexplained.** `inbound_emails` records `created_at`
  (when the webhook wrote the row) and nothing about when the customer sent it, so "the
  provider was slow" and "the list is frozen" were indistinguishable from the data. When a
  latency complaint cannot be attributed, that is a schema gap, not a mystery.

## L26. Ask "who is this from" before "what is this" — a classifier must never judge a reply
*22 Aug 2026, reported as "kafi time ho gaya message aaye abhi tak show nahi ho raha".*

The message had arrived three minutes earlier, with fifteen more in the preceding two hours.
It was in the database with status `skipped_non_enquiry`, which `lib/inbound/folders.ts` files
under **Spam / System**, out of the Inbox. `api/webhooks/inbound-email/route.ts` asked its two
questions in this order:

```
line 431   if (!extracted.isEnquiry) -> skipped_non_enquiry, stop
line 445   is there an open lead with this sender? -> append to it
```

The skip came first. So a mid-thread reply — *"actually I need 20 users of Standard, not 50 of
Starter"* — was handed to Gemini, asked "is this a sales enquiry?", and correctly answered
**no**. It is not an enquiry. It is the most important message in the thread. It went to Spam.

**The rules:**
- **Identity before classification.** A message from somebody you already have an open
  conversation with is never spam: you know who they are and what it is about, so there is
  nothing left to decide. A classifier earns its keep on mail from STRANGERS — that is the only
  case where the question is open. Reordering two `if`s was the entire fix.
- **The model was not wrong; the question was.** This is the failure mode to watch for in AI
  plumbing. Nothing in a log would show a bad classification to go hunting for, because the
  classification was right. Auditing prompts and model output would have found nothing.
- **An absent verdict is not a "no".** `isEnquiry: null` means the model never ran (no key,
  timeout, breaker open) and must resolve to "show the operator", never to "spam". Otherwise a
  real customer's first email vanishes during an outage — the one time nobody is watching.
- **Filing something out of sight needs a stated reason.** The row recorded *that* it was
  skipped and never *why*, so answering "where is my email" took a database query. Every
  disposition now carries a reason (`lib/inbound/disposition.ts`).
- **The lesson generalises past email.** Any pipeline that both (a) recognises known entities
  and (b) classifies unknown ones must run the recognition first. Otherwise the classifier gets
  asked about things it was never meant to judge, and answers anyway.

## L27. Postgres block comments NEST — a glob inside one breaks the whole function
*23 Aug 2026, writing the invoice-immutability trigger.*

The migration would not parse:

```
ERROR: 42601: unterminated /* comment at or near "/* An escape hatch that has to be…
```

The comment was closed. What was not closed was the comment *it* opened: the prose said
"the same shape as `supabase/maintenance/*.sql`", and that path contains a slash-star.
PostgreSQL follows the SQL standard here and **nests** block comments, unlike C — so the
inner `/*` opened a second comment and the single `*/` closed only that one, swallowing the
entire remaining function body.

**The rules:**
- **Never write a glob path inside a `/* */` block in SQL.** Say "the files under
  supabase/maintenance", or use `--` line comments, which do not nest.
- **The error names the OUTER comment, not the glob.** It points at the line where the
  comment began, which is where you already know the comment is fine. The offending
  characters can be forty lines further down.
- **Verifying in a rollback transaction caught it before it reached the operator.** This is
  the second thing that pattern has paid for (see L24) — a migration that cannot parse is
  indistinguishable, from the outside, from one that applied.

## L28. A money guard needs its ALLOW list tested as hard as its BLOCK list
*23 Aug 2026, the same trigger.*

Freezing an issued invoice's particulars is the easy half. The half that decides whether the
guard survives is what it must still permit, and two of those would have broken a working
feature outright:

- **`gst_irn`** arrives from the IRP only AFTER the invoice is issued. Freeze it and
  e-invoicing cannot ever complete — a guard that makes the compliant path impossible.
- **`adjusted_advances` / `net_payable` / `first_advance_at`** carry a real post-issue
  settlement (CGST 31(3)(d), migration 0209). Freezing them would have looked correct and
  silently killed advance adjustment.
- **A NULL particular must stay fillable.** `taxable_value`/`tax_amount`/`tax_rate`/
  `inter_state` arrived in a later migration, so older invoices hold nulls. Filling a blank
  completes the record; replacing a value amends the document. Two tiers, not one.

**The rules:**
- **Write the ALLOW cases into the test, with the reason each one exists.** Otherwise the
  next person reading only BLOCK assertions cannot tell a carve-out from an oversight, and
  "tighten this up" removes a load-bearing exception.
- **Run the entire suite with the guard active, not just its own test.** 38/39 with it on is
  the claim worth making; the guard's own test passing says nothing about `record_payment`.
- **Give a guard a stated-reason escape hatch, not none.** `set local
  app.invoice_amend_reason = '<why>'` is transaction-scoped, greppable, and reached by no
  application code path. A guard with no legitimate override is a guard somebody eventually
  drops — and there IS a legitimate need here: 41 invoices carry a due_date that predates the
  net-30 fix.

## L29. Strip the quoted thread BEFORE reading a reply — or you read your own words back
*23 Aug 2026, building Phase 1.*

A reply carries the whole previous conversation underneath it. The message that started
all of this was, in full:

```
Actually, I need the quotation for 20 users of Google Workspace Business
Standard, not 50 users of Starter. Please adjust that.

On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:
> Thank you for your enquiry for 50 users of Google Workspace Business
> Starter. …
```

Both numbers and both product names are in that body. **Only the quoted half is ours.**
Anything that reads the raw text to learn what the customer wants — a regex, a model —
is reading our own previous message as if the customer had just said it. For a feature
that WRITES what it reads, that is not cosmetic: it would overwrite 20 with 50 and
record the customer as the source.

**The rules:**
- **Strip first, always** (`lib/inbound/strip-quoted.ts`), and take the EARLIEST marker,
  not the first pattern in your list — a Gmail quote can contain an Outlook divider
  further down, and matching by list order keeps the Gmail block.
- **Fail toward empty, never toward the full text.** The tempting fallback — "if
  stripping left nothing, use the original" — reinstates the quoted thread in exactly
  the case where the parse went wrong. Empty means nothing-to-do.
- **A trailing `>` block is quoted; an inline `>` is not.** A `>` in the middle of fresh
  text is the customer quoting a phrase to answer it. Cutting there loses their answer.
- **Test with the bytes from the database, not a transcription.** Three things about the
  real message are invisible when you retype it tidily: it is CRLF, the catalogue name is
  WRAPPED mid-phrase ("Google Workspace Business\r\nStandard"), and both figures are
  present. A hand-written fixture had none of them and passed while the real message
  would have failed on all three — including a silent miss in `findProduct`, whose exact
  substring match cannot see its own product across a line break.

## L30. Fix the RECORD, not the sentence that reads from it
*23 Aug 2026, after three failed attempts at the same bug.*

A customer said twice that they wanted 20 users of Standard, not 50 of Starter. Three
separate fixes went into the reply DRAFT — stop restating the figures, then a different
staleness rule, then a third — and every one of them was a fresh coat of paint. The
actual state was that `leads.seats` was still 50 and `leads.plan` was still Starter,
because nothing had ever written the correction down.

While that is true, the draft is not the only thing wrong: every quote, every renewal and
every future reply derived from that row is wrong too, and each is its own bug to be
reported later.

**The rule:** when a displayed value is wrong, ask whether the STORED value is wrong
before touching the display. If it is, the display needs no special case at all — it
becomes correct for free, and so does everything else reading the same row. Three of my
attempts at this were spent on the reading end because the reading end is where the
symptom appears.

**Corollary on tools:** this needed no model. `lib/inbound/extract.ts` already read seats
and product with tested regexes and already returned the source sentence each value came
from, which is strictly better here — it cannot invent a number, cannot drift between
runs, and the audit trail is free. Reach for the deterministic thing that exists before
adding an LLM, a wait, a cost and a failure mode.

## L31. Registering ONE more table in the generated Database type can collapse all of it
*23 Aug 2026, adding `document_series` for the invoice-issue dialog.*

`document_series` was missing from `src/lib/supabase/database.types.ts`, so reading
`last_number` did not typecheck. The obvious fix — declare the Row type and add one line
to `Tables` — did this:

```
without the change:     4 errors
with the change:    2,722 errors
```

Every unrelated table collapsed to `never` (`Property 'customer_id' does not exist on
type 'never'`). supabase-js resolves row types through a large conditional-type chain,
and a `Database` type this size sits close enough to the instantiation-depth limit that
one more member tips it over. Nothing in the error output points at the table you added.

**The rules:**
- **Diagnose by removing, not by reading.** `git stash push -- <the types file>` and
  re-run typecheck. Four errors versus 2,722 is a one-command answer; staring at the
  first ten errors tells you nothing, because they are all in files you never touched.
- **Do not add the table.** Put the one query that needs it behind a route with a
  deliberately UNTYPED client (`createClient` from `@supabase/supabase-js`, no generic),
  in a file small enough to read in full — `api/invoices/series/route.ts`. Keep the Row
  interface as the written record of the shape even though nothing references it from
  `Tables`.
- **An untyped client has no tenant checking.** With no generated types, nothing verifies
  the filter, so an explicit `.eq("tenant_id", …)` IS the entire boundary. Write it on
  the next line and say so in a comment.
- **A cast is not the cheaper option here.** It looks smaller and it is worse: L5 —
  a cast added to get one table through stops checking everything else in the call.

## L32. Fixing "never file it as spam" turned every echo of our own mail into a lead
*23 Aug 2026. My regression, caught by the operator within the hour: "ye lead kyo bani".*

L26 reordered the inbound webhook so a known sender's reply is never classified, and
added: an absent verdict (`isEnquiry: null` — Gemini did not run) resolves to `create`
rather than `skip`, so a real customer's first email cannot vanish during an outage.
Sound reasoning, and it created a new bug the same day.

Every reply on a thread arrives **twice** — once at the customer-facing address, once at
the address we send FROM, because that address is in the thread. Those echoes used to be
filed as spam. Now each one created a lead, named from the domain fallback
(`fromEmail.split("@")[1].split(".")[0]` → "anutech"), with no seats and no plan, sitting
in New beside the real one. The data showed it exactly: the same sender, `skipped` at
514 and 494 minutes ago, `lead_created` at 4.

**The rules:**
- **Our own address is never a customer.** Check it before everything else, including
  before the known-lead lookup — appending the echo would duplicate a thread that already
  records the outgoing message as sent.
- **Match exact addresses, never the domain.** "Anything @anutech.in is ours" silently
  drops a reseller buying for itself, and this app's whole first customer is the tenant
  itself. Collect `tenants.email`, the tenant's `users.email`, and the connected
  `user_google_tokens.google_email` — that last one is what replies actually leave from
  and need not equal any user's login (the "Send as" picker exists for that).
- **When widening a default from "drop" to "surface", ask what ELSE arrives on that
  path.** The change was correct for the case it was written for and wrong for the case
  nobody enumerated. "What else reaches this branch?" is the question that would have
  caught it before the operator did.
- **`user_google_tokens` has no `tenant_id`.** Scope it through the tenant's user ids.
  An unfiltered read under the admin client pulls every tenant's sending address into
  "ours", and then a genuine enquiry from another reseller gets silently dropped — I
  wrote that filter-less query first and caught it before it shipped.

## L33. Before building a list of "the N dangerous actions", check each one exists
*23 Aug 2026, Phase 2.*

My own plan named four irreversible taps: issue invoice, send quote, record payment,
suspend/cancel. Measuring found:

| tap | reality |
|---|---|
| issue invoice | a bare `onClick`, plus a BULK loop over every selected quote |
| send quote | a dialog existed, describing the mechanism and not the commitment |
| record payment | a dialog existed with a title and nothing else |
| suspend/cancel | **not an action in this app at all** |

Only one of four was the job I had written down. The nearest thing to the fourth —
deleting a subscription — already confirms well (what it does, what it is for, and the
alternative when it is blocked). Building a "suspend" tap would have been inventing a
feature to satisfy my own list.

**The rules:**
- **A plan is a hypothesis about the code.** CLAUDE.md §25 says that about docs; it is just
  as true of a plan written an hour ago by me. Grep for each item before starting.
- **"Add a confirmation" and "make the existing confirmation honest" are different jobs.**
  Two of these already had dialogs. The work was not a dialog, it was the sentences —
  which is a smaller change and a harder one to spot as missing.
- **Report the count you found, not the count you promised.** Saying "the real work is
  two, not three, and here is why" is the deliverable; quietly building four would hide
  that the fourth was fictional.

## L34. A money guard's copy must name the consequence nobody would guess
*23 Aug 2026, writing the three consequence modules.*

The mechanical description is the one that gets written and the one that helps least.
"Email a copy of the quote PDF to the customer" is true and tells the operator nothing
they did not already intend. What each act actually needed was the fact they could NOT
have inferred:

- **Send quote** — the accept link works without you, so they can commit you at any hour;
  and a *resend* does not replace the earlier email, so two prices now sit in the thread
  and the customer picks which to read.
- **Record payment** — it issues a GST **receipt voucher** under CGST Section 31(3)(d),
  consuming a serial from the same gapless machinery as an invoice. No screen had ever
  mentioned this. ANUTECH holds zero payments with that counter at 39.
- **Issue invoice** — the number is spent either way, because deleting the invoice retires
  it rather than freeing it (migration 0118).

**The rules:**
- **Say the recovery as well as the risk.** "Delete the payment in Payments — that unwinds
  the customer and subscription cleanly. The receipt-voucher number does not come back."
  An operator who knows the way back acts on a mistake; one who does not, leaves it.
- **Never build the list from invented figures.** The send dialog renders nothing at all
  unless the caller passes real amounts. Defaulting to zero would have put "₹0 goes to the
  customer" on a real quote — a sentence the operator might believe.
- **Phrase by outcome when you cannot know the cause.** "No subscription and no renewal
  are created" is true whether the reason is a one-off sale (guard 0157) or line items with
  no billing commitment. I dropped an `isOneOff` field I could not populate honestly rather
  than let the caller guess it.
- **Move a check EARLIER when the earlier act is the exposing one.** The quote-total-vs-GST
  check lived only on the invoice path. Sending is what actually puts the figure in front
  of the customer, so it belongs there too — by invoice time the number is already quoted.

## L35. When a feature ships "term-aware", check every place the term is used — not just the one you touched
*23 Aug 2026, Phase 3.*

On 22 Aug a term-aware reminder ladder shipped so monthly subscriptions renew properly.
`term_months` appears four times in `api/cron/renewals/route.ts`. It appears **zero**
times in `lib/renewals/create-renewal-quote.ts`, which priced every renewal as:

```ts
const annualAmount = Math.round((input.mrr ?? 0) * 12);
```

So the reminders knew the subscription was monthly and the PRICE did not. The work
stopped at the thing being changed and never followed the concept.

Measured on the row that renews first — c398e832, "Xyz cloud solutions", 10 seats of
Business Starter, `term_months = 1`, renewal 27 Aug, `auto_renew = true`:

```
correct one month     10 × 270      = ₹2,700 ex-GST    → ₹3,186 incl
what it would quote   32,400 × 12   = ₹3,88,800 ex     → ₹4,58,784 incl
```

about **144×**, four days out, on a subscription set to renew by itself. Two defects
compounding: the hardcoded 12-month term, and `mrr` on that row holding an ANNUAL figure
(₹3,240/seat against a ₹270 catalogue price) where every other subscription stores a
genuine per-month rate.

**The rules:**
- **Grep the CONCEPT, not the file.** After making anything term-aware / tenant-aware /
  currency-aware, grep the whole tree for the field and read every hit. The dangerous one
  is the file with zero hits that should have had some.
- **Refuse; do not repair.** The tempting fix for an annual-looking `mrr` is to divide by
  12. That produces a plausible number from data known to be untrustworthy, and a
  plausible wrong price on a customer-facing quote is the worst outcome available. Stop and
  say what to fix.
- **Set the sanity threshold where it catches the neighbours too.** `suspectAnnualMrr`
  triggers above 2× the catalogue rate, not at exactly 12×, so a 3× or 6× mistake is
  caught as well — and a genuine monthly rate slightly above MSRP still passes, which is
  what stops the guard being deleted as a nuisance.
- **A derived label is part of the price.** The quote line's `commitment` was hardcoded
  `annual_yearly`. `record_payment` reads it to decide what subscription to build on the
  way back in, so a one-month renewal labelled annual rebuilds the wrong subscription —
  the error survives the round trip.
