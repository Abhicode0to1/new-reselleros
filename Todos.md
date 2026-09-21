# Todos — ResellerOS ↔ DMS integration

Recorded 2026-09-19. Last updated **2026-09-21**, after the renewal security fix and the
front-door change.

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
- [ ] **The 25 admin pages still wrap themselves in `<AdminLayout>`.** The shell is now
      mounted once by `app/admin/layout.tsx`, and those wrappers render as passthroughs via
      a context flag rather than being deleted — deliberately, because the flicker had to
      stop that day and rewriting 25 pages with no per-page tests is the larger risk. They
      can be removed one at a time; a page with the wrapper and one without render the same
      tree, so there is no midpoint that breaks. Same for the 19 pages rendering
      `<AdminLayoutSkeleton>`. Until then `components/skeletons/AdminLayout.tsx` still
      carries a `bg-blue-900` sidebar for its standalone use outside /admin — worth
      converting whenever that path is next touched.
- [ ] **The DMS palette conversion was narrower than I reported.** I said "~2,900 legacy classes
      → 7". The 7 was real but measured only over `app/admin`; `app/dashboard` is genuinely 0.
      The conversion ran over the panel *page* directories and `components/admin` (53 left) /
      `components/user` (16 left), and never covered `components/` root — where shared
      components rendered *inside* the panels live. Measured 2026-09-21 across
      `app/` + `components/` .tsx: **1,272 remain** (was 1,302 before the 21 Sep modal/menu
      batch; re-measured, not carried forward). Panel-scoped: `components/admin` 48,
      `components/user` 16, `app/admin` 8, `app/dashboard` 0. Much of that is the public marketing site and checkout, which were
      never in scope — but `components/DomainRenewalModal.tsx` (30 instances) renders inside
      the customer panel at `/dashboard/domains`, so the panels are not uniformly converted.
      Worth a pass keyed on *what the panels render*, not on directory names.
- [ ] **The local stack's safety is configuration, not isolation.** The DMS container has working
      internet and resolves ResellerClub's real host fine; only the `.invalid` values in
      `.env.docker` stop it reaching them. Once write commands exist, add a code-level gate so a
      stray real credential is not sufficient on its own.
- [ ] **Commit-email linkage unverified.** Commits use `pawan@exceltechnologies.in`; they will
      only link to the GitHub account if that address is verified under Settings → Emails.
- [ ] **No PR opened from here.** `gh` is not installed on this machine, so whether one
      exists was NOT verified — only that neither was opened by me. Links:
      `github.com/Abhicode0to1/new-reselleros/pull/new/pawan-api-system` and
      `github.com/exceltechnologies-india/domain-management-system/pull/new/pawan-api-system`.
      Worth doing soon: AGENTS.md §9 notes CI runs on PRs and pushes to `main` but NOT on
      feature branches, so the local gate is currently the only gate on both.
- [ ] **Abhishek's merged screens are untested by me.** The suite passes and the migrations are
      applied, but I did not click through the new contacts / subscriptions pages.
