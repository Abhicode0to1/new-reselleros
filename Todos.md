# Todos — ResellerOS ↔ DMS integration

Recorded 2026-09-19, updated after the merge and push.

Both repos now carry a branch named **`pawan-api-system`**, both pushed:
- ResellerOS — `Abhicode0to1/new-reselleros` (this repo), merged with `abhishek-pre-merge`
- DMS — `exceltechnologies-india/domain-management-system`
  (`C:\xampp\htdocs\Domain-Management-Project`)

Local stack: DMS on **4310** (`docker compose up -d` in the DMS repo), ResellerOS on **4320**
(`npm run dev -- -p 4320`), local Supabase on 14321/14322, local inbox on 14324.
Sign in with `dev-local@anutech.invalid` / `local-dev-password-1234` (owner, Anutech Digital).

Verification key: **[verified]** = read end-to-end in the code and confirmed here ·
**[reported]** = raised by review, not independently confirmed.

---

## A. Pre-existing bugs — unrelated to this integration, live today

These were found while designing the write commands. None of them are caused by the
integration work; all of them are reachable in DMS as it stands. They come first because the
new design's guards assume they are fixed.

- [ ] **Any logged-in customer can spend money on renewals** — `app/api/domains/renew/route.ts`
      **[verified]**
      The POST handler authenticates (`AuthService.getUserFromRequest`) and then calls
      `rcRenewDomain({ domainName, years })` with `domainName` taken straight from the request
      body. There is **no ownership check** between the two, so any authenticated customer can
      renew any domain at our expense. `paymentId` also comes from the body and is never
      verified against Razorpay — and `components/DomainRenewalModal.tsx:76` mints one
      client-side under the comment *"Create a mock payment ID for testing"*. The handler then
      books an order with `status: "completed"`.
      Fix: bind the domain to the caller (`Domain.findOne({ domainName, userId, deletedAt: null })`),
      require a verified payment the way `/api/payments/verify` does, add idempotency. Its
      `hard_failure` branch also returns HTTP 500 — the status callers retry — on exactly the
      transport-ambiguous cases.

- [ ] **A paid, registered domain can vanish from the database** — `models/Domain.ts:81-85`,
      `lib/services/payment/provisioner.ts:150`, `provisioner-domain.ts` **[verified]**
      `Domain.orderId` is declared `unique: true, sparse: true`, but `provisionCartItems` fans a
      single `orderId` across every domain in the cart. On a two-domain order the second
      `Domain.create` throws E11000 — and the catch logs it and falls through to
      `return { registrationResult: { status: "success" } }`. Money spent, domain registered at
      ResellerClub, no `Domain` row: invisible to renewals, expiry reminders, the dashboard and
      every guard the new design relies on.
      Fix: drop the unique constraint (it is a one-to-many relation) or key on
      `(orderId, domainName)`; either way stop swallowing the insert failure.
      **Run `getIndexes()` against the real cluster first** — the live blast radius depends on
      whether the index was actually built.

- [ ] **Repeat customers' second hosting order is silently discarded** —
      `lib/services/pending-hostings.ts:208-215` **[verified]**
      `provisionPendingHosting` deletes the row when `user.directAdminUsername` is set and
      returns `{ ok: true, dropped: true }`. That field is set for anyone with any prior
      account, so every returning customer's second paid hosting order is dropped, and the
      `check-unprovisioned` cron counts it as a success.
      Fix: make the guard per-domain via `listUserHostingsByDomain`.
      While there: the same function calls `updateDNSNameservers` (hard-disabled, always
      throws), hardcodes a 365-day term, and fabricates an `orderId`.

- [ ] **Admin pending-domain retry destroys in-flight records** —
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
- [x] **Demo customer** on `/portal/login` (`portal-test@anutech.invalid`), with a link to the
      local inbox where the emailed code lands. Verified: RPC true → OTP 200 → mail delivered.
- [x] **Pointer to it** from the staff panel on `/login` — a link, not an autofill row, because
      a customer credential cannot authenticate against `signInWithPassword`.
- [x] **One shared `DevDemoPanel`** so the two panels cannot drift apart again.

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

Baseline after the merge: **DMS 6365** tests green · **ResellerOS 6610** green.

---

## C. Engine write commands — build order

Full design in the workflow output (`w4j8nmjxo`). 17 agents, 106 problems raised, 28 blockers.
Phases are ordered so each guard ships **before** the capability it guards.

- [ ] **Phase 0** — fix the four bugs in section A above.
- [ ] **Phase 1** — make failure legible. Add a structural `transport` flag to the ResellerClub
      register/renew response and a `code` discriminator to `DirectAdminError`. Today a
      param-build throw and a post-POST socket reset produce the *identical* string, so no
      message-matching can separate "nothing was sent" from "it may have landed". Stop
      `DirectAdminService.createUser` blind-retrying a non-idempotent create (it defaults to
      `maxRetries: 2`).
- [ ] **Phase 2** — idempotency store and subject mutex, with no route reachable yet.
      `EngineCommand` + `EngineSubjectClaim` (unique on `{command, subject}`, **not** on
      `commandId` — a request-keyed index does not stop two legitimate commands registering the
      same name).
- [ ] **Phase 3** — the operator's screen, and a DB-level guard making `payment_mode` unwritable
      by a tenant member, so the test-mode gate is genuinely independent layers.
- [ ] **Phase 4** — every route and the whole caller path exercised with `mode: "live"` hard
      disabled. `mode` is a required enum with no default.
- [ ] **Phase 5** — recovery before the thing that needs recovering: command read endpoint,
      read-and-settle reconciliation, operator resolve/requeue actions.
- [ ] **Phase 6** — first real commands, free and reversible: DNS records, hosting
      suspend/unsuspend.
- [ ] **Phase 7** — hosting provision and plan change (reversible spend).
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
- [ ] **The hosting password.** DMS's `createUser` generates a throwaway and never returns it;
      ResellerOS generates its own and emails it. After retirement the failure mode is silent.
- [ ] **Make `ENGINE_COMMANDS_ENABLED` per-command** (`dns.record,hosting.suspend`) rather than
      one global switch — four phases want live traffic while register stays dark.
- [ ] **Run `getIndexes()` against the real databases** before the `Domain.orderId` fix and the
      Phase 7 `Hosting` uniqueness change.

---

## E. Open questions — unresolved, mostly unverifiable locally

- [ ] Does ResellerClub actually emit the prose in `BALANCE_PENDING_FRAGMENTS` etc.? Those lists
      are DMS's *model* of RC behaviour; the local RC host is unreachable by design.
- [ ] **Is a domain renewal idempotent at ResellerClub, or does a second call add a year?** Not
      determinable from either codebase. If it adds a year, renewals need the same per-row human
      release that registrations get.
- [ ] What does DirectAdmin actually say when a *domain* (not username) is already hosted?
- [ ] Is the ResellerClub account prepaid or on credit? Changes whether `balance_pending` is the
      dominant ambiguity or a rarity.
- [ ] Does a ResellerOS-originated hosting command travel DMS's DirectAdmin egress path, and is
      it covered by the four-layer IP whitelist?
- [ ] Does the local Supabase match the committed migrations? No DB query was run in that pass.

---

## F. Housekeeping and known gaps

- [ ] **The domain/hosting UI still does not exist in ResellerOS.** No `/portal/domains`, no
      `/portal/hosting`, no `(app)/assets` console, no `src/lib/domains`. `abhishek-pre-merge`
      did **not** bring it — that branch is contacts / subscriptions / billing. So the
      port-vs-rewrite decision against the abandoned `anutechbilling` tree (which has all of it
      working) is still open, and it gates any plan to retire DMS's own panels.
- [ ] **The local stack's safety is configuration, not isolation.** The DMS container has working
      internet and resolves ResellerClub's real host fine; only the `.invalid` values in
      `.env.docker` stop it reaching them. Once write commands exist, add a code-level gate so a
      stray real credential is not sufficient on its own.
- [ ] **Customers cannot set a password.** `/portal/login` now offers email + password, but
      portal accounts are created by the OTP flow (`shouldCreateUser: true`), which sets none,
      and there is no set-password or forgot-password screen anywhere under `/portal`. So today
      the password field works only for an account someone set a password on by hand. The
      emailed code is kept as the way through, and must stay until this exists. Needed: an
      invite/set-password flow, plus a real reset.
- [ ] **The portal demo customer depends on a local seed row** —
      `customers.contact_email = portal-test@anutech.invalid`, AND a password set on that auth
      user (`PortalDemo@2026`, set by hand locally). Both exist on this machine and may not on a
      fresh checkout, where the demo button will simply look broken. Worth adding to the seed.
- [ ] **Commit-email linkage unverified.** Commits use `pawan@exceltechnologies.in`; they will
      only link to the GitHub account if that address is verified under Settings → Emails.
- [ ] **Neither branch has a PR open.** ResellerOS:
      `github.com/Abhicode0to1/new-reselleros/pull/new/pawan-api-system`.
- [ ] **Abhishek's merged screens are untested by me.** The suite passes and the migrations are
      applied, but I did not click through the new contacts / subscriptions pages.
