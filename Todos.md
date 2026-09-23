# Todos — ResellerOS ↔ DMS integration

Recorded 2026-09-19. Last updated **2026-09-23**, after engine Phases 6-7 and a re-measure
of §F's counts (three of which were wrong — see §0).

Both repos now carry a branch named **`pawan-api-system`**, both pushed:
- ResellerOS — `Abhicode0to1/new-reselleros` (this repo), merged with `abhishek-pre-merge`
- DMS — `exceltechnologies-india/domain-management-system`
  (`C:\xampp\htdocs\Domain-Management-Project`)

Local stack: DMS on **4310** (`docker compose up -d --build` in the DMS repo), ResellerOS on
**4320** (`npm run dev -- -p 4320`), local Supabase on 14321/14322, local inbox on 14324.
Sign in with `dev-local@anutech.invalid` / `local-dev-password-1234` (owner, Anutech Digital).

**ResellerOS is DMS's front door.** `NEXT_PUBLIC_RESELLEROS_URL` is set as a docker-compose
**build arg**, so DMS's `/` 307s to `localhost:4320` and its logo points there. Changing it
needs `docker compose up -d --build`, not a restart — `NEXT_PUBLIC_*` is inlined by
`next build`. With ResellerOS not running, DMS's `/` will look broken; that is the redirect
working.

Verification key: **[verified]** = read end-to-end in the code and confirmed here ·
**[reported]** = raised by review, not independently confirmed.

---

## 0. What is left — measured 2026-09-23

Everything below is verified against the code today, not carried forward. Where an older
entry in this file disagrees, **this section is the measurement** and the older one has been
corrected in place. Grouped by who can move it, because most of what remains is not code.

### 0.1 Yours — nothing else can proceed past these

- [x] **DMS migration 008 — APPLIED TO PRODUCTION 2026-09-23** at Pardeep's direction, on the
      `domain-management` Atlas database. Verified in a separate run (§5): `_migrations` holds
      8, `orderId_1` is now `unique=false sparse=true`, and **`resellerClubOrderId_1` is still
      unique** — that is the index which actually prevents a double registration, and it was
      the thing to check. `domains` held 0 rows, so the recreate was instant and no data was
      at risk.
      **It failed on the first attempt and that was a runner bug, not the database.** `await
      import()` was handed an absolute Windows path and threw `Received protocol 'c:'` before
      `up()` ran, so nothing was applied and no ledger row was written — confirmed against
      production before retrying. Fixed with `pathToFileURL` (DMS `b90140a`); 001-007 predate
      the Node version that enforces this, which is why it surfaced on 008.

- [ ] **ResellerOS migration `20260921100000` — production DEFERRED at Pardeep's direction
      (2026-09-23), local VERIFIED.** Not merely "applied locally": checked against the running
      database rather than the migration file (L8 — a migration is not evidence a guard exists).
      · `pg_proc` / `pg_trigger` on the local DB: `guard_provisioning_request_facts` and
      `provisioning_requests_facts_immutable` both present.
      · `supabase/tests/provisioning_facts_immutable.test.sql` exits 0 with all five locked
      columns refused AND the complete-a-request workflow still working — the ALLOW half, which
      is the half that decides whether a guard survives contact with the people it constrains.
      · **Red-checked**: dropping the trigger made the test exit 3 with
      `FAIL: a tenant member changed payment_mode — a test payment can be activated`. The
      trigger was restored from the migration file and re-verified in a separate run. So exit 0
      here means something; it is not a file that silently did nothing.
      **Still to do:** the same migration on production, whenever that becomes possible. Until
      then the hole is open there — a tenant member can flip `payment_mode` from `test` to
      `live`, clear `blocker`, and have the worker provision real hosting against a payment that
      settled zero rupees.
      Note for whoever runs it: `npx supabase status` prints the DEFAULT ports (54322/54321);
      the real local mapping is **14322/14321**, which `docker ps` shows. Commands aimed at
      `--linked` go to PRODUCTION, not local.
- [ ] **Domain renewal retail pricing.** Blocks the renewal checkout. There is no retail
      renewal price anywhere in DMS — `getRenewalPricing` returns the *registrar's cost*.
      Inventing a markup would put a made-up figure on a real charge, so nothing was invented
      and the modal routes to support instead.
- [ ] **Does an engine-provisioned hosting account get a DMS portal user?** Blocks
      `hosting.provision` (Phase 7's other half). DMS mints a `Math.random()` password it never
      returns because its customers arrive by SSO — so without a portal user there is no way in
      at all, and provisioning reports success.
- [ ] **Who is the seller of record for an engine-sourced sale?** Blocks Phase 9. DMS's GST
      engine is permanent and ungated; credit notes are manual with a statutory deadline.
      Needs the CA.
- [ ] **How does a ResellerOS-only buyer get a ResellerClub customer?** Blocks Phase 9.
      `registerDomain` needs a numeric `customerId`, and contacts come from a private helper
      inside DMS's payment pipeline.
- [ ] **Which side owns DirectAdmin?** Two writers means two username derivations. It does
      NOT block `hosting.change_plan`, which shipped — that command works with the existing
      `(userId, domainName)` uniqueness rather than changing it.
- [x] **Is a renewal idempotent? ANSWERED 2026-09-23 — as we call it today, NO.** And the
      answer came from our own code, not the vendor docs.
      RC's `renew.json` requires `exp-date`, documented as "Current Expiry Date of the Order in
      epoch time format". That is an optimistic-concurrency guard — and
      `resellerclub-wrapper.ts:136` **re-reads the expiry on every call** and passes whatever it
      just read. So on a retry after a renewal we did not hear back from:
      `getDomainExpiry` returns the NEW expiry, we pass that, it matches, and RC renews again.
      **A retry buys a second year.** The guard that would have stopped it is defeated by our
      own pre-flight.
      No vendor page states the duplicate-call behaviour (the KB is 403 to fetching and the
      published parameter tables are silent on it), but the conclusion does not depend on it:
      if RC validates `exp-date` we pass a valid one, and if it ignores `exp-date` the renewal
      proceeds anyway. Either way the second year is bought.
      **This retrospectively proves the 409 shipped earlier today was right** — the renewal
      route refuses to invite a retry on `sent_unknown`, and that was precautionary when
      written. It is now measured.

- [ ] **Phase 8's design follows from that, and it is better than a human release.** The
      pre-renewal expiry is the reconciler: record it before calling, and on an ambiguous
      outcome re-read it. **Moved → the renewal happened. Unchanged → it did not, and a retry
      is free.** A pure read with a definite answer, which is exactly the bar Phase 6 set for
      giving a command a reconciler — so `domain.renew` can be automated safely rather than
      parked for a person.
      Two things still worth asking RC support, now much narrower than the original question:
      does `renew.json` REJECT a mismatched `exp-date`, and is there a request-id style
      idempotency key? If it rejects, passing the ORIGINAL exp-date on a retry turns that field
      into a proper idempotency key and the ambiguity disappears.

### 0.2 Mine — buildable now, in this order

- [ ] **Phase 8 — `domain.renew`. UNBLOCKED 2026-09-23.** The idempotency question is
      answered: a retry buys a second year as we call it today (see §0.1). The design that
      falls out is a reconciler on the expiry date — record it before the call, re-read it on
      ambiguity, moved means done — which is a pure read with a definite answer and needs no
      human release. Ready to build.
- [ ] **Phase 9 — `domain.register`.** Last, behind two fail-closed env gates and a per-row
      human release. Blocked on both §0.1 decisions above it.
- [x] **Per-command live control — the CODE half is built (2026-09-23).** The env-var half is
      NOT, deliberately: `engine-mode.ts` and its test both warned that the env-var version
      belongs to the phase carrying two fail-closed gates and a per-row human release, and that
      a single flag added as a convenience would look like the same thing and be much weaker.
      That warning still holds, so nothing here reads the environment.
      **What was actually wrong was worse than a missing env var.** `LIVE_COMMANDS_ENABLED` was
      written when the only handler was `engine.selftest`, which contacts nothing — one boolean
      was a complete answer because flipping it could do nothing. Phases 6 and 7 added four
      provider-touching handlers and the boolean never changed, so the cheapest wrong action
      available (flip one constant) would have armed **every** command at once, `domain.register`
      included. L74 exactly.
      Now `LIVE_ELIGIBLE_COMMANDS` is what the flag may enable and `LIVE_INELIGIBLE_REASONS`
      names what it must never reach, with the reason doubling as the caller's refusal. A
      command in neither list is refused — silence is "no" — and a test asserts every known
      command is classified, so a handler added in Phase 8/9 cannot inherit a default.
      Proved by flipping the constant to `true` against the real harness: the three dangerous
      commands stayed refused, the three eligible ones armed.
      **Still open for Phase 9:** the two fail-closed env gates and the per-row human release.
- [x] **The renewal route's `hard_failure` 500 — FIXED 2026-09-23.** `RenewDomainOutcome`'s
      failure now carries a `transport`, and the route picks its status by how far the request
      got rather than by whose fault it is: `not_sent`/`responded` → **502** "nothing was
      renewed, safe to try again"; `sent_unknown` → **409** "do NOT try again, a second attempt
      could buy an extra year", with an error log naming the domain, the payment and the reason.
      409 because nothing retries it by itself, and because that is this repo's existing code
      for "your state conflicts with this request".
      Stated rather than hidden: the wrapper does an order-id/expiry PRE-FLIGHT inside the same
      call, so an ambiguous throw from that lookup also reads `sent_unknown`. That errs toward
      "a human checks", the safe direction for a spend that cannot be taken back.

- [x] **A bookkeeping failure was reported as a failed RENEWAL — found while fixing the above,
      fixed 2026-09-23.** `createOrder` and `appendUserDomain` ran inside the same `try` as the
      registrar call, so a throw returned 500 and "Failed to renew domain" about a renewal that
      had just succeeded — the customer reads a failure, presses renew again, and buys a second
      year. This route's own history is a ValidationError thrown in exactly that spot on every
      run, after the registrar had been charged. Bookkeeping now has its own `try`; on failure
      the response says the renewal worked, flags `recorded:false`, says there is no need to
      renew again, and logs loudly.
- [x] **`appendUserDomain` / the renewal expiry gap — FIXED 2026-09-23. The "decision" was
      not needed: the code had already made it.** `GET /api/user/domains` fills a Map from
      recent orders, then pending domains, then the **Domain collection LAST**, so Domain rows
      overwrite the other two. Its own comment states the precedence and the insertion order
      implements it. Canonical source = the Domain collection; `User.domains` is read by
      nothing.
      **That made the gap bigger than a stale date.** `daily-scheduler` selects on
      `next_action_at <= now`, derived from `expiresAt` at row creation, and nothing updated
      either after a renewal — so a renewed domain kept its pre-renewal trigger and the cron
      went on reminding the customer to renew what they had just renewed, feeding the same rows
      to renewal dunning.
      `applyDomainRenewal` now writes `expiresAt` + `next_action_at` and clears
      `last_reminder_sent` (the trio the provisioner sets together), with `reminderTriggerFor`
      shared rather than copied a third time.
      **The expiry is read from ResellerClub, never computed.** `now + years × 365d` is wrong
      by however long was left, because a renewal extends the CURRENT expiry — and that wrong
      date would land in the customer's view and the reminder ladder looking authoritative.
      `orders.endtime` is not a guess: `app/api/domains/sync` already parses it as Unix seconds.
      No usable expiry from RC → nothing written, and logged.
      `appendUserDomain` is deprecated and now WARNS instead of pretending. Kept, not deleted,
      because the domain TRANSFER route still calls it and has no canonical write of its own —
      deleting it would erase the last trace of that gap while leaving the gap.

- [ ] **Domain TRANSFER has no canonical write.** Same shape as the renewal bug above, still
      open: `app/api/domains/transfer` calls the deprecated `appendUserDomain` and never writes
      a `Domain` row, so a transferred-in domain does not appear in the customer's list and gets
      no reminder schedule. Not fixed here because a transfer's expiry comes from the losing
      registrar and the flow was not read end to end — it needs its own pass, not a copy of the
      renewal fix.

### 0.3 Corrections to this file's own numbers (all re-measured today)

Three §F claims were wrong. They are corrected in place below; recorded here because the
pattern matters more than the numbers — **a count in a doc is a hypothesis** (§12).

- **The palette conversion is far less complete than recorded.** §F said 1,272 remain, with
  `app/admin` 8 and `app/dashboard` **0**. Measured today with
  `(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate)-[0-9]{2,3}`
  over `app/` + `components/` .tsx: **2,573 across 151 files** — `app/admin` **563**,
  `app/dashboard` **200**, `components/admin` 111, `components/user` 18. A claim of 0 is
  falsified by any single match, and `app/dashboard/dns-management/page.tsx` alone holds
  `bg-green-500`, `text-green-700`, `border-green-200`. The earlier figure is not
  reproducible because its pattern was never written down — which is why the pattern is
  written above.
- **Admin wrappers: 20 pages, not 25**, and `AdminLayoutSkeleton` appears in **20** files,
  not 19. Still passthroughs via the context flag, still safe to remove one at a time.

### 0.4 Known and accepted — not work, but do not rediscover them

- [ ] **No PR is open on either branch, deliberately.** Standing instruction: do not open one
      unless asked. Recorded so the next reader does not treat its absence as an oversight —
      AGENTS.md §10 rule 4 now says the same. The consequence to keep in mind: CI runs on PRs
      and pushes to `main` only, so on these branches the local gate is the only gate.
- [ ] **The local stack's safety is configuration, not isolation.** The DMS container has
      working internet and resolves ResellerClub's real host; only the `.invalid` values in
      `.env.docker` stop it reaching them. Now that write commands exist, this wants a
      code-level gate so a stray real credential is not sufficient on its own.
- [ ] **`gh` is not installed on this machine**, re-checked today. Anything needing the GitHub
      API has to happen in a browser.

---

## A. Pre-existing bugs — unrelated to this integration, live today

These were found while designing the write commands. None of them are caused by the
integration work; all of them are reachable in DMS as it stands. They come first because the
new design's guards assume they are fixed.

- [x] **Any logged-in customer can spend money on renewals** — `app/api/domains/renew/route.ts`
      **[verified]** — **FIXED 2026-09-21** (DMS `pawan-api-system`)
      The POST handler authenticated and then called `rcRenewDomain({ domainName, years })`
      with `domainName` straight from the body — no ownership check — and took an unverified
      `paymentId`, which `components/DomainRenewalModal.tsx:76` minted client-side under the
      comment *"Create a mock payment ID for testing"*. So no payment was ever taken.

      **It was worse than recorded here.** `razorpayOrderId`/`razorpayPaymentId` are
      `required: true` on the Order schema (since the initial commit) and the route never
      passed them, so `createOrder` threw a ValidationError into the catch on **every** run —
      *after* `rcRenewDomain` had already charged the registrar. Proved by `validateSync()`
      against the real schema, not inferred. Live behaviour was therefore: the domain really
      renewed, the reseller really paid, no row was written, and the customer saw
      "Failed to renew domain" — so a second click spent it again.

      **The fix recorded here was also wrong**: it proposed
      `Domain.findOne({ domainName, userId })`. No route in DMS does ownership that way; the
      repo-wide idiom is `findOrderByDomainForUser` + `findOrderDomain` against `Order`
      (`lib/services/orders.ts:1183`), used by domains/dns, domains/verify-status and others.
      That is what was built. Shipped: ownership gate on GET **and** POST; Razorpay ids
      replacing the free-text `paymentId`, run through the canonical `verifyRazorpayPayment`;
      a replay check on `getOrderByRazorpayPaymentId`; both required ids now passed to
      `createOrder`. All four gates red-checked by removing them one at a time.

      Still open, deliberately: the `hard_failure` branch returns HTTP 500 — the status
      callers retry — on transport-ambiguous cases. Not touched, because a retry on this
      route is exactly the L3 shape (a second run is not idempotent) and it needs its own
      thinking.

- [ ] **Domain renewal has no checkout, so the Renew button cannot work** —
      `app/api/domains/renew/route.ts`, `components/DomainRenewalModal.tsx` **[verified]**
      Consequence of the fix above, and the reason it is safe: the route now demands a
      verified payment, and **nothing in the app can produce one for a domain renewal.**
      There is no retail renewal price anywhere in DMS — `renewalPrice` is a `HostingPlan`
      field, and `getRenewalPricing` returns the *registrar's cost*, not what a customer pays.
      Inventing a markup would put a made-up figure on a real charge, so it was not invented.
      The modal now says renewal is not self-service yet and routes to `/dashboard/support`.
      To finish it: decide the markup, then mirror `app/api/user/hosting/renew/route.ts` —
      server-price it, `RazorpayService.createOrder`, persist a pending Order, and let
      `/api/payments/verify` drive the registrar call. **Needs an operator pricing decision
      first.**

- [ ] **`appendUserDomain` writes nothing at all** — `lib/services/users.ts:466`,
      `models/User.ts` **[verified]**
      It does `$push: { domains: … }` on `User`, and `models/User.ts` declares no `domains`
      path — Mongoose strict mode (on by default; the options block sets no `strict:false`)
      silently drops it. `models/User.ts:93` and `:416` already document this exact hazard for
      other fields. Two callers: the renew and transfer routes.
      The real gap behind it: **nothing updates `expiresAt` on the user's existing order after
      a renewal**, so a renewed domain keeps showing its old expiry. Needs a decision about
      where a user's domain list is canonically read from (`Order.domains[]` vs the `Domain`
      collection — both exist, and `lib/services/domains.ts` is used by neither ownership gate)
      before either is worth fixing. Left in place with a comment rather than deleted, so the
      symptom does not get tidied away while the gap stays.

- [x] **A paid, registered domain can vanish from the database** — `models/Domain.ts:81-85`,
      `lib/services/payment/provisioner.ts:150`, `provisioner-domain.ts` **[verified]**
      `Domain.orderId` is declared `unique: true, sparse: true`, but `provisionCartItems` fans a
      single `orderId` across every domain in the cart. On a two-domain order the second
      `Domain.create` throws E11000 — and the catch logs it and falls through to
      `return { registrationResult: { status: "success" } }`. Money spent, domain registered at
      ResellerClub, no `Domain` row: invisible to renewals, expiry reminders, the dashboard and
      every guard the new design relies on.
      Fix: drop the unique constraint (it is a one-to-many relation) or key on
      `(orderId, domainName)`; either way stop swallowing the insert failure.
      **FIXED 2026-09-21.** `getIndexes()` run against the LOCAL cluster: the index was real
      (`unique: true, sparse: true`). Reproduced the loss — two inserts on one orderId, second
      E11000, one row of two stored — then migration `008_drop_domain_orderid_unique.ts`, after
      which three of three store. `resellerClubOrderId` keeps its unique index and still refuses
      a duplicate, checked in the same run. The swallowed error now writes a SystemLog naming the
      domain; it still does not rethrow, because the customer has paid and the registrar has
      registered.
      **STILL TO DO: migration 008 has only been applied LOCALLY.** Running it against production
      is yours — it drops and recreates an index on a live collection.

- [x] **Repeat customers' second hosting order is silently discarded** —
      `lib/services/pending-hostings.ts:208-215` **[verified]**
      `provisionPendingHosting` deletes the row when `user.directAdminUsername` is set and
      returns `{ ok: true, dropped: true }`. That field is set for anyone with any prior
      account, so every returning customer's second paid hosting order is dropped, and the
      `check-unprovisioned` cron counts it as a success.
      **FIXED 2026-09-21** — guard is now per `(user, domain)` via `listUserHostingsByDomain`.
      Still open in the same function: `updateDNSNameservers` (hard-disabled, always throws), a
      hardcoded 365-day term, and a fabricated `orderId`. And the account-model question stands:
      a repeat customer now gets a SECOND DirectAdmin user rather than an addon domain on the
      existing one — see §D, "which side owns DirectAdmin".

- [x] **Admin pending-domain retry destroys in-flight records** —
      `app/api/admin/pending-domains/[id]/register/route.ts` **[reported]**
      Calls `ResellerClubWrapper.registerDomain` directly and branches on
      `result.status === "success"`, so a `balance_pending` (returned as `status: "pending"`)
      lands in the else and marks the row `failed` — destroying the only record that a queued
      name is in flight, on a name ResellerClub may be about to register.
      Fix: use the typed `registerDomain` with the same five-way switch `provisionDomainItem`
      uses, and take a name lock before the call.

---

## B. Done

### The integration (reads + identity)
- [x] **Engine read API** (DMS) — `GET /api/integrations/engine/health` and `.../services`,
      three-key auth by blast radius, all fail closed, constant-time compare. 11 unit tests.
- [x] **ResellerOS engine client** — server-only, never throws, fail-closed on missing config.
      14 tests including 3 live round-trips.
- [x] **Staff page + nav** — `/hosting-domains` under Operations.
- [x] **SSO hand-off** — ResellerOS → DMS, 60s TTL, single-use `jti` in Redis, own secret.
      15/15 adversarial checks: no impersonation, no auto-provisioning, no role escalation,
      replay refused, expired refused, wrong-secret refused, disabled account refused.
- [x] **Local Docker stack** — DMS + Mongo + Redis, all paid upstreams pointed at `.invalid`.

### Dev ergonomics
- [x] **One shared `DevDemoPanel`** so the staff and DMS panels cannot drift apart.
- [x] **Demo accounts on DMS's `/login`** — admin + customer, dev-only via the
      `NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS` build arg. They go through the real credentials
      provider; a wrong password and a disabled account are both still refused.
- ~~Demo customer on `/portal/login`~~ — **superseded**: the ResellerOS customer portal was
      deleted on 2026-09-19 (§F). The `/login` row now links straight to DMS's sign-in.

### Fixed along the way
- [x] `GOOGLE_CLIENT_ID!.trim()` — the `!` compiles to nothing, so an unset var threw at module
      load and took down **all** DMS authentication, not just Google.
- [x] A test mock that hardcoded `id:"credentials"`, so 16 password-login tests silently
      asserted against the wrong provider once a second Credentials provider existed.
- [x] Redis being dragged into the DMS auth import path (now imported lazily).
- [x] `/hosting-domains` registered in `route-map.ts`, which a test enforces.

### Repo work
- [x] Branches created, committed and pushed on both repos as `pawan-api-system`.
- [x] Merged `abhishek-pre-merge` (contacts, subscriptions, dunning, billing — 90 files,
      5 migrations). No conflicts; `nav.ts` auto-merged.
- [x] Applied those 5 migrations to **local** Supabase, plus a PostgREST schema reload.
- [x] Commits re-attributed to `Excel Technologies <pawan@exceltechnologies.in>`.

### Front door + UI (2026-09-21)
- [x] **DMS wears the ResellerOS design** — sign-in shell, admin + customer chrome, and the
      page interiors converted to the ResellerOS palette. Not uniform yet: see §F.
- [x] **ResellerOS is DMS's front door** — one build arg, `NEXT_PUBLIC_RESELLEROS_URL`.
      DMS's `/` 307s to ResellerOS and every brand/home link points there; unset, DMS is
      standalone and unchanged. Enforced in `middleware.ts` (for the status) and
      `app/page.tsx` (the guarantee), both reading `lib/reseller-os.ts`.
      Browser-verified, and red-checked in both places.

### UI parity + polish (2026-09-21, second batch)
- [x] **React Query devtools removed** — its palm-tree button had been mistaken for part of
      the app three times (once by me, twice by the operator). Dev-only, never shipped.
- [x] **DMS sign-in link opens in the same tab** — dropped `external: true`, which the shared
      panel couples to both the new tab and the ↗ arrow.
- [x] **ActionMenu on the tokens** — one shared component, so all four admin pages that use
      it (users, domains, hosting, orders). Also fixed its off-screen guard, which measured
      mid-animation through `scale: 0.95` and let the menu hang past the viewport edge.
- [x] **Shared Modal + its contents on the tokens** — five surfaces. Found a test that had
      gone VACUOUS: it selected the overlay by `.bg-gray-500.bg-opacity-75`, so after the
      restyle it clicked `null` and its "not called" assertion passed for the wrong reason.
- [x] **Page transitions actually run** — `tailwindcss-animate` was never installed and
      `plugins: []`, so `animate-in` / `fade-in` / `zoom-in-95` / `slide-in-from-right` were
      inert strings in ~10 places. Installed, plus `key={pathname}` on both shells so the
      entrance replays per route instead of once per page load.
- [x] **The admin shell mounts once** — there was no `app/admin/layout.tsx`, so all 25 pages
      rendered `<AdminLayout>` themselves and every navigation destroyed and rebuilt the
      sidebar, flashing `AdminLayoutSkeleton`'s pre-restyle `bg-blue-900` sidebar in between.
      Measured: sidebar node replaced, absent at some frames, nav links hitting 0 — all three
      now false.

### Security (2026-09-21)
- [x] **Domain renewal required no owner and no payment** — see §A, which has the detail.
      Ownership gate on GET and POST, real Razorpay verification, replay check, and the
      `createOrder` call that had been throwing on every run since the initial commit.

Baselines, measured 2026-09-21: **DMS 6,408** tests across 431 files ·
**ResellerOS 6,609** across 356 files (+1 file / 4 tests skipped). Both typecheck clean.

---

## C. Engine write commands — build order

Full design in the workflow output (`w4j8nmjxo`). 17 agents, 106 problems raised, 28 blockers.
Phases are ordered so each guard ships **before** the capability it guards.

- [x] **Phase 0** — fix the four bugs in section A above. **DONE 2026-09-21.** All four
      shipped and red-checked: the renewal security hole, the vanishing domain, the
      discarded repeat hosting order, and the admin retry that marked queued
      registrations failed. §A's two remaining items are not bugs to fix — they are
      decisions (renewal pricing; where a user's domain list is canonically read from).
      **Caveat: migration 008 is applied LOCALLY only.** Phase 0 is not truly closed on
      production until it runs there.
- [x] **Phase 1** — make failure legible. **DONE 2026-09-21.**
      `lib/integrations/transport.ts` records not_sent / sent_unknown / responded at the
      only place that knows — the function doing the sending — and `isSafeToRetry` is true
      for exactly one of them. Wired into registerDomain and renewDomain; the failure
      message now leads with what we know about delivery.
      **The load-bearing call:** ECONNRESET and ETIMEDOUT are NOT safe. A reset can arrive
      after the bytes were acted on, a timeout only means we stopped waiting. Only
      ENOTFOUND / ECONNREFUSED / EAI_AGAIN prove nothing was sent; anything unrecognised
      falls to sent_unknown.
      DirectAdmin's `executeRequest` retried on `!status || status >= 500` — and `!status`
      lumped a refused connection together with a reset after send, so `createUser` (the
      default maxRetries: 2) would fire again and create a second account. Now it retries
      on >= 500 or a proven not-sent, which fixed all 21 callers without touching a call
      site. Red-checked: restoring `!status` fails exactly the five possibly-landed cases.
      **Not done here:** the `code` discriminator on `DirectAdminError` itself. The retry
      decision no longer needs it — it reads the transport — so it is only worth adding
      when a caller has to branch on WHY a DA call failed rather than whether to retry.

- [x] **Phase 2** — idempotency store and subject mutex. **DONE 2026-09-21.**
      `EngineCommand` (unique `commandId` — "have I been asked this exact thing?") and
      `EngineSubjectClaim` (unique `{command, subject}` — "is something already happening
      to this thing?"), plus `lib/services/engine-commands.ts`. Nothing under `app/`
      imports any of it; verified, since that is half the phase.
      The distinction was demonstrated against the real database, not asserted: two
      `domain.register` claims on one domain → second blocked (11000); `dns.edit` on the
      same domain → acquired; delete by a non-holder → 0; and **the same claim keyed on
      `commandId` instead → both allowed, collision invisible** — the design this phase
      exists to avoid, run as an experiment.
      **The expensive line:** `needs_reconciliation` does NOT release the claim. It means
      the provider came back `sent_unknown` (Phase 1), so the work may have happened, and
      freeing the subject would let the next attempt register the same domain twice.
      `releaseAfterReconciliation` is separate on purpose — the code that could not tell
      what happened must not also be the code that frees the lock. Red-checked.
      Two things a future reader should not "tidy": the claim TTL is a safety net rather
      than the release path (if it is doing the releasing, something died holding a lock),
      and there is deliberately no TTL on `EngineCommand` — an expired row would let the
      same commandId spend again.

- [x] **Phase 3** — operator's screen + DB guard on the provisioning facts. **DONE 2026-09-21.**
      Migration `20260921100000_provisioning_facts_are_immutable.sql` + a BEFORE UPDATE
      trigger, plus `/provisioning` and `GET /api/provisioning/queue`.
      **The hole:** `provisioning_requests_update` checked only `tenant_id`, so a tenant
      member could edit every column — including the two `listReadyHostingRequests` reads
      (`payment_mode = 'live'`, `blocker is null`). A `test` row settles ZERO rupees and
      looks identical to a real one, so flipping it meant real hosting provisioned free.
      **Wider than payment_mode on purpose:** `blocker` is the other half of the same WHERE
      clause; `seats`/`amount_paid`/`vendor`/`quote_id` are the record of what was paid for.
      `status`/`activated_at`/`vendor_ref`/`note` stay writable — that is the whole
      complete-a-request workflow. It enumerates the FORBIDDEN columns, so a column added
      later is locked by omission rather than writable by omission.
      **The screen found a real row on its first run** — a hosting activation queued 7 days
      earlier, invisible because nothing had ever opened this table. Test-mode, so no money
      settled, but nobody could have known that either.
      ⚠️ **Applied to LOCAL Supabase only.** Production needs the migration run.

- [x] **Phase 4** — the command route, live hard-disabled. **DONE 2026-09-21.**
      `POST /api/integrations/engine/commands` + `lib/integrations/engine-mode.ts` and
      `engine-command-registry.ts`. The whole caller path runs; nothing in it can spend.
      `mode` is required with NO default — defaulting to live lets a forgotten field spend
      real money, defaulting to test silently answers for the caller and changes every one
      of them the day it flips. `live` is refused in CODE (`LIVE_COMMANDS_ENABLED = false`),
      not by config: a flag would make "is live on?" a question about a running system.
      **503, not 403** — the caller's key is fine, so a 403 sends someone to rotate a good
      credential. Known-but-unimplemented is 501, unknown is 400.
      Exercised against the running engine, not only unit-tested: read key → 401, missing
      mode → 400, live → 503, unknown → 400, `domain.register` → 501, selftest → 200, the
      **same commandId with a CHANGED payload returned the ORIGINAL result** (a replay, not
      a re-run), and a claimed subject → 409 without freeing the existing claim. Afterwards:
      one command row, zero claims, and the indexes Mongoose built are the designed ones.
      Found while wiring it: `BILLING_COMMAND_API_KEY` was declared EMPTY in `.env.docker`,
      so the route was unreachable — fail-closed working as designed. Given a local dev
      value; production still has no value, which is correct until Phase 9.
      Red-checked by flipping `LIVE_COMMANDS_ENABLED` to true: four tests fail, all about money.

- [x] **Phase 5** — recovery, built before the things that need it. **DONE 2026-09-21.**
      `GET /api/integrations/engine/commands/:commandId` (read endpoint),
      `lib/integrations/engine-reconcile.ts` (read-and-settle), and
      `POST /api/admin/engine-commands` (operator settle / resolve / requeue).
      **The read endpoint is on the READ key, not the command key** — otherwise anything
      that polls a command's status holds the key that can register domains, and polling is
      the most widely deployed part of any integration.
      **A reconciler reads and never writes.** The command it is settling may already have
      taken effect, so a write risks being the second one — recovery would become the most
      dangerous operation in the system. `unknown` never settles: guessing "not_done" re-runs
      work that may have happened, guessing "done" leaves a customer who paid for nothing
      with nobody looking. A throwing reconciler is `unknown` too.
      **The reconciler registry is EMPTY on purpose** — one written against an API nobody
      calls is a guess about a response shape, and a wrong guess settles commands incorrectly
      while looking authoritative. Each arrives with its command in Phase 6+.
      **Operator actions are admin-only and NOT on the engine contract.** ResellerOS cannot
      know whether the work happened — it is the side that asked and got no answer. `who` and
      `why` are required: a row saying a claim was freed without either is worse than none.
      **Requeue does not retry** — it frees the subject and stops.
      Exercised end to end on a planted stuck command: read → safeToRetry:false; unknown id →
      404 "safe to send again"; settle with no reconciler → claim STAYS held; resolve without
      evidence → 400; with evidence → claim released; resolve again → 409; requeue → released
      with "send a NEW commandId". Both engine collections left empty.
      Noted from the run: a new command on a locked subject returns **501, not 409** — the
      handler gate runs before the mutex. Gate order, not a bug.

- [x] **Phase 6** — first real commands, free and reversible: DNS records, hosting
      suspend/unsuspend. **DONE 2026-09-21.**
      `lib/integrations/engine-handlers-hosting.ts` and `engine-handlers-dns.ts`, registered in
      BOTH maps — `HANDLERS` (performable) and `RECONCILERS` (settleable).
      **These two first because they are free and reversible.** A suspend can be unsuspended
      and a DNS record set back; the worst case is a site down or pointing at the wrong place
      until somebody notices. They also both have an OBSERVABLE effect, which is what lets
      them be the first commands with reconcilers — "is this account suspended", "does this
      record hold this value" are pure reads with definite answers.
      **Test mode is "no writes", not "offline".** It reads the current state and reports what
      a live run would change. Said plainly in both headers, because "test mode does not
      contact the provider" would be a comforting sentence and a false one.
      **Already-in-the-asked-for-state is a SUCCESS.** A retry is the commonest reason to send
      the same command twice; failing there makes a correct state look like a fault and leaves
      the operator unsure which run was real.
      **A failure before any write THROWS**, so the route records `transport: "not_sent"` and
      the claim is released — nothing can have half-happened. And `not_found` reconciles to
      `unknown`, never `not_done`: a missing account means the username is wrong or it was
      deleted, neither of which says whether the suspend landed.
      **DNS upserts read first.** A blind add leaves two A records for one host, which resolve
      round-robin — an outage that presents as "it works for me". An existing record with no id
      is refused rather than duplicated. NS and SOA are not settable (changing nameservers moves
      the whole domain's DNS, which is not a small reversible edit), and a TTL under
      ResellerClub's 7200 floor is refused rather than silently raised.
      **Two things found while building it.** `updateDNSRecord`'s second argument is the RECORD
      id, not the customer id — an `as never` cast made customerId compile there and was
      removed (AGENTS.md L5). And ResellerClub is imported LAZILY: `lib/resellerclub/client.ts`
      throws at module load without env, so a static import made the whole registry
      un-importable — `hosting.suspend`, which only talks to DirectAdmin, would have 500'd
      because of a registrar's credentials.
      46 new tests, **red-checked** by reintroducing all three defects at once (customerId in
      the recordId slot, already-suspended acted on, `not_found` → `not_done`): 6 assertions
      went red, then green on restore. Full suite 444 files / 6,670 tests, typecheck clean.
      `hosting.provision`, `hosting.change_plan`, `domain.renew` and `domain.register` still
      have NO handler, with a test that fails the day one of them gets one.
      **Verified how:** test-verified and reasoned-only. **No call has been made to
      DirectAdmin or ResellerClub** — live is still hard-disabled at 503 from Phase 4, so the
      provider response shapes are read from this repo's existing wrappers, not observed.
- [x] **Phase 7** — plan change (reversible spend). **PARTIAL, 2026-09-21.** `change_plan`
      is built; **`hosting.provision` is NOT, and that is the finding** — see below.
      `lib/integrations/engine-handlers-plan.ts`, registered in both maps.
      **The plan comes from the catalogue, not the caller.** The payload names a `planId` and
      the DirectAdmin package is read from that plan's row. A caller-supplied package name
      would be a second source for something the catalogue owns — the L104/L106 family, where
      a copied figure went wrong and the guard checking it had been fed the same copy. A test
      sends `newPackage: "Ultimate"` in the payload and asserts DirectAdmin is still told
      `"Plus"`.
      **Both halves are the effect.** DMS stores the plan on the `Hosting` row (`planId`,
      `name`, `serverPackage`) and its own upgrade path writes all three after the DA call. A
      command that changed only DirectAdmin would leave the customer panel showing the old
      plan with no error anywhere, so the record is written too — and the reconciler returns
      `done` only when BOTH agree. Checking DA alone would settle a half-done command.
      **Ambiguity is refused before DirectAdmin is touched.** `Hosting` is unique on
      `(userId, domainName)`, **not** on the DA username, so one account can own several rows.
      Two matches, or none, is a refusal with the domains listed — picking one would be a guess
      about whose plan changed.
      Case is compared insensitively, because `changePackage` normalises what it sends and an
      exact compare would report a successful change as `not_done`. An inactive plan is
      allowed and flagged rather than refused (L103: a guard that fires on a right answer gets
      deleted; a downgrade to a retired tier is legitimate).

- [ ] **`hosting.provision` — blocked, and not on effort.** DMS's `createUser` mints the
      username itself and sets `passwd: Math.random().toString(36).slice(-10) + 'A1!'`, which
      it never stores and never returns. That is deliberate: the comment beside it says "user
      will use SSO", and DMS customers reach DirectAdmin by passwordless SSO from the DMS
      portal. So an engine-provisioned account for somebody with **no DMS portal user has no
      way in at all**, and provisioning reports success. The decision needed is not "which
      password" — it is whether an engine-provisioned account gets a portal user, and who owns
      the username. Supersedes the "hosting password" item in §D.

- [x] **Transport was never wired to the route — found while building Phase 7, fixed.**
      Phase 4's catch recorded `transport: "not_sent"` unconditionally, with a comment saying
      "no handler here contacts anything yet". True when written; **Phase 6 made it false** and
      nothing forced the comment to change. So a DNS write that died mid-flight was recorded as
      never sent, its subject claim was released, and the caller was told "Nothing was changed"
      about a request ResellerClub may have applied — the exact failure `classifyTransport` was
      built for in Phase 1, arriving through the one door nobody had wired it to.
      `lib/integrations/engine-attempt.ts` brands a thrown error with how far it got, and the
      route reads it: `sent_unknown` → `needs_reconciliation`, which HOLDS the claim.
      **Three outcomes, not two.** A provider that ANSWERS "no" is `responded`, not
      `sent_unknown` — collapsing them would park a subject for a human with nothing to decide,
      and that is how a guard becomes a nuisance and gets deleted.
      Reads are deliberately not wrapped: a read that fails changed nothing.
      `engine-transport-wiring.test.ts` is a SOURCE SCAN, because every existing engine test
      asks whether a decision is right and this was wiring (L85). It asserts the route reads
      the brand and that every provider write in a handler is wrapped.
- [ ] **Phase 8** — domain renew (first unrecoverable rupee, on a domain we already own).
- [ ] **Phase 9** — domain register, last, behind two fail-closed env gates and a per-row human
      release.

### Invariants the implementation must not break

1. `effect` starts `"unknown"`. No catch, timeout or default branch may narrow it to `"none"`.
2. `retryable` is never derived from `effect`; it is an explicit allowlist with a runtime assert.
3. The claim is the insert's E11000, never a `findOne` before it.
4. A subject claim is released only on a proven `effect: "none"` — never on a timeout, never by
   a sweeper.
5. A stale claim is an operator ticket, never an automatic re-run.
6. Any re-send carries the **original** `commandId`. Minting a new one for an already-sent
   command is the one forbidden operation.
7. A dry run writes nothing, claims nothing, and makes no mutating outbound call.
8. The command endpoints create no Order, Payment or Invoice in DMS — DMS's GST engine is
   permanent and ungated, so reusing the paid path would mint a second tax invoice for one
   supply.
9. The rate limiter is not a spend control (it returns `allowed: true` when Redis is absent).
10. A test-mode Razorpay payment can never reach a live command.

---

## D. Decisions needed — these block phases

- [ ] **Who is the seller of record for an engine-sourced sale?** Blocks Phase 9. DMS's GST
      engine is permanent and ungated; credit notes are manual with a statutory deadline. Needs
      the CA.
- [ ] **How does a ResellerOS-only buyer get a ResellerClub customer?** Top blocker for
      register. `registerDomain` needs a numeric `customerId` and contacts that today come from
      a private helper inside DMS's payment pipeline.
- [ ] **Which side owns DirectAdmin?** Keeping both writers means two username derivations and
      two definitions of `vendor_ref`. Blocks Phase 7.
- [x] **The hosting password — measured, and it is not a password question.** DMS's
      `createUser` sets a `Math.random()` throwaway it never returns *on purpose*: its comment
      says "user will use SSO" and DMS customers reach DirectAdmin by passwordless SSO from the
      DMS portal. So the real question is whether an engine-provisioned account gets a DMS
      portal user — without one there is no way in at all. Still blocks `hosting.provision`.
- [x] **Per-command live control — code half built 2026-09-23** (see §0.2). That env var never
      existed; what exists is `LIVE_COMMANDS_ENABLED`, hardcoded, and it is now per-command via
      `LIVE_ELIGIBLE_COMMANDS` / `LIVE_INELIGIBLE_REASONS`. Enabling a command is still a code
      change and a deploy. The env gates remain Phase 9's, with the human release.
- [x] **`getIndexes()` — done for the half that mattered.** Run against the local cluster
      before the `Domain.orderId` fix (the index was real; migration 008 followed). The
      "Phase 7 `Hosting` uniqueness change" half is **moot**: `hosting.change_plan` shipped
      working WITH the existing `(userId, domainName)` unique index rather than altering it —
      it refuses when two rows match instead. Still worth running against PRODUCTION before
      migration 008 goes there.

---

## E. Open questions — unresolved, mostly unverifiable locally

- [ ] Does ResellerClub actually emit the prose in `BALANCE_PENDING_FRAGMENTS` etc.? Those lists
      are DMS's *model* of RC behaviour; the local RC host is unreachable by design.
- [x] **Is a domain renewal idempotent at ResellerClub?** ANSWERED 2026-09-23 — see §0.1. It
      WAS determinable from this codebase, which is the lesson: `resellerclub-wrapper.ts`
      re-reads the expiry on every call and passes it as `exp-date`, so a retry presents a
      valid current expiry and renews again. The question was recorded as unanswerable without
      anyone reading the wrapper.
- [ ] What does DirectAdmin actually say when a *domain* (not username) is already hosted?
- [ ] Is the ResellerClub account prepaid or on credit? Changes whether `balance_pending` is the
      dominant ambiguity or a rarity.
- [ ] Does a ResellerOS-originated hosting command travel DMS's DirectAdmin egress path, and is
      it covered by the four-layer IP whitelist?
- [ ] Does the local Supabase match the committed migrations? No DB query was run in that pass.

---

## F. Housekeeping and known gaps

### ResellerOS has no customer portal (decided 2026-09-19)
`src/app/(public)/portal`, `src/app/api/portal` and `src/lib/portal` were **deleted** — 24
files, plus the nav entry, 11 route-map entries and a robots disallow. DMS owns the customer
experience; staff reach it from the demo panel on `/login`, which opens DMS's sign-in directly.

Consequences accepted with the decision:
- ResellerOS's OWN customers (Workspace / M365 / Zoho subscriptions) now have **no
  self-service at all** — no orders, invoices, subscriptions or ticket-raising. DMS cannot
  serve them: it knows nothing about those products. Everything is staff-mediated until
  something replaces it.
- The email+password sign-in and the demo customer built just before this are gone with it.

- [ ] **The database side was deliberately NOT touched.** Still present: six `portal_*`
      functions (`portal_customer_exists`, `portal_ensure_customer_link`,
      `portal_list_hosting_plans`, `portal_list_products`, `portal_request_quote`,
      `portal_touch_login`), their RLS policies, and 8 migrations that mention the portal.
      Dropping live DB objects is a separate and riskier act than deleting code, and applied
      migrations are history rather than something to delete. Decide whether to drop the
      functions in a new migration, or leave them dormant.
- [ ] **`customers.contact_email` and the portal auth users are now orphaned** for their portal
      purpose. Nothing reads them, but `portal-test@anutech.invalid` and any real portal
      sign-ins remain in `auth.users`.


- [ ] **The domain/hosting UI still does not exist in ResellerOS.** No `/portal/domains`, no
      `/portal/hosting`, no `(app)/assets` console, no `src/lib/domains`. `abhishek-pre-merge`
      did **not** bring it — that branch is contacts / subscriptions / billing. So the
      port-vs-rewrite decision against the abandoned `anutechbilling` tree (which has all of it
      working) is still open, and it gates any plan to retire DMS's own panels.
- [x] **DMS's legal + marketing pages now redirect to ResellerOS** (2026-09-21, operator's
      call after the Razorpay risk was raised). `/privacy`, `/terms-and-conditions`,
      `/cancellation-refund`, `/contact` and `/about` 307 to their ResellerOS equivalents
      for non-admins, under the same `NEXT_PUBLIC_RESELLEROS_URL` switch.
      **Redirected, never 404ed** — Razorpay needs a merchant's policy pages publicly
      reachable, so the content moved rather than vanished, and every target is a real
      ResellerOS page (`/terms`, `/refund`, `/enquiry`, and two 1:1). Admins still get DMS's
      copy so the pages stay checkable. Verified with real sessions against the container.
      **One thing to check before this reaches production**: Razorpay's dashboard holds the
      registered policy URLs for the merchant account, and those likely point at
      `app.anutech.in`. This switch is off in production (`deploy-cloud-run.sh` passes no
      such var), so nothing is live yet — but turning it on there means updating those URLs
      to the ResellerOS origin first, or the account's policy links 307 off-domain.
- [ ] **The purchase funnel is deliberately NOT taken over.** `/hosting`, `/domains/*`,
      `/cart` and `/checkout` are the **only working way to buy hosting or a domain**;
      ResellerOS has marketing pages for both but no management UI (see below). Tests in
      both `lib/reseller-os.test.ts` and `middleware.test.ts` pin that these are untouched,
      so widening the map fails rather than quietly removing the way to sell. Decide this
      together with the port-vs-rewrite question below, not before it.
- [ ] **DMS's public nav still links "Home" to DMS's `/`**, which now redirects — so it costs
      a hop rather than being wrong. Left alone because that link carries `isActive('/')`
      styling and rewiring it means swapping `<Link>` for `<a>`. Worth doing if the marketing
      pages are kept long-term.
- [ ] **The 20 admin pages still wrap themselves in `<AdminLayout>`** (re-counted 23 Sep; this said 25). The shell is now
      mounted once by `app/admin/layout.tsx`, and those wrappers render as passthroughs via
      a context flag rather than being deleted — deliberately, because the flicker had to
      stop that day and rewriting 25 pages with no per-page tests is the larger risk. They
      can be removed one at a time; a page with the wrapper and one without render the same
      tree, so there is no midpoint that breaks. Same for the 20 files rendering
      `<AdminLayoutSkeleton>` (re-counted 23 Sep; this said 19). Until then `components/skeletons/AdminLayout.tsx` still
      carries a `bg-blue-900` sidebar for its standalone use outside /admin — worth
      converting whenever that path is next touched.
- [ ] **The DMS palette conversion was narrower than I reported.** I said "~2,900 legacy classes
      → 7". The 7 was real but measured only over `app/admin`; `app/dashboard` is genuinely 0.
      The conversion ran over the panel *page* directories and `components/admin` (53 left) /
      `components/user`, and never covered `components/` root — where shared
      components rendered *inside* the panels live.
      **The figures previously here were wrong** — see §0.3. Re-measured 2026-09-23 with
      `(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate)-[0-9]{2,3}`
      over `app/` + `components/` .tsx: **2,573 across 151 files**. Panel-scoped:
      `app/admin` **563**, `app/dashboard` **200** (this file claimed 0, and
      `app/dashboard/dns-management/page.tsx` alone disproves it), `components/admin` 111,
      `components/user` 18. The old numbers are not reproducible because their pattern was
      never recorded, which is the actual lesson. Much of that is the public marketing site and checkout, which were
      never in scope — but `components/DomainRenewalModal.tsx` (30 instances) renders inside
      the customer panel at `/dashboard/domains`, so the panels are not uniformly converted.
      Worth a pass keyed on *what the panels render*, not on directory names.
- [ ] **The local stack's safety is configuration, not isolation.** The DMS container has working
      internet and resolves ResellerClub's real host fine; only the `.invalid` values in
      `.env.docker` stop it reaching them. Once write commands exist, add a code-level gate so a
      stray real credential is not sufficient on its own.
- [ ] **Commit-email linkage unverified.** Commits use `pawan@exceltechnologies.in`; they will
      only link to the GitHub account if that address is verified under Settings → Emails.
- [ ] **No PR opened from here, and that is now the standing rule** — do not open one unless
      explicitly asked (AGENTS.md §10 rule 4, 23 Sep). `gh` is not installed on this machine
      (re-checked 23 Sep), so whether one exists was NOT verified. Links:
      `github.com/Abhicode0to1/new-reselleros/pull/new/pawan-api-system` and
      `github.com/exceltechnologies-india/domain-management-system/pull/new/pawan-api-system`.
      Worth doing soon: AGENTS.md §9 notes CI runs on PRs and pushes to `main` but NOT on
      feature branches, so the local gate is currently the only gate on both.
- [ ] **Abhishek's merged screens are untested by me.** The suite passes and the migrations are
      applied, but I did not click through the new contacts / subscriptions pages.
