# Todos — ResellerOS ↔ DMS integration

Recorded 2026-09-19. Last updated **2026-09-24 (evening)**, after enabling the ResellerOS site
cart (ResellerOS `c49cd098`). Earlier the same day: the billing-architecture decisions 1–21
(§0A), DMS pricing moved to ResellerOS + GST (DMS `06a9546`), DMS's public pages removed (DMS
`0fe6c95`), and the Billing & Subscriptions hands-off guard (AGENTS.md §13). Before that
2026-09-23: engine Phases 6-8, the production apply of DMS migration 008, and merging
`abhishek-pre-merge`.

**Gates at the last update:** ResellerOS 6,668 tests / 362 files, typecheck clean, lint exit 0
(warnings only). DMS 6,702 / 445, typecheck clean, lint 0 errors.

**Read §0A first.** It is the newest record and supersedes older entries below where they
conflict; each superseded entry is marked in place.

Both repos now carry a branch named **`pawan-api-system`**, both pushed:
- ResellerOS — `Abhicode0to1/new-reselleros` (this repo). **`abhishek-pre-merge` merged in on
  2026-09-23** (`c300b335`): subscription drawer, bulk actions, sortable headers, licence
  leakage on rows, and a refactor replacing `licence-audit.ts` with `facts.ts` + `sort.ts`.
  No conflicts — he had already merged this branch into his, so the only overlap was docs.
  Gate on the merged tree: 6,629 tests / 357 files, typecheck clean, lint exit 0 (warnings).
  **This line previously claimed the merge had already happened and it had not** —
  `git merge-base --is-ancestor` said no. It describes a real merge now.
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

## 0A. BILLING ARCHITECTURE — decided by Pardeep, 24 Sep 2026

**This supersedes two older entries in this file**, which are corrected in place below:
§D's Zoho entry ("DMS's own GST engine is the only invoice issuer" — true about Zoho,
overtaken on billing) and the "purchase funnel is deliberately NOT taken over" entry.

### Decisions (USER DECISIONS — do not re-litigate)

| # | Decision | In Pardeep's words |
|---|---|---|
| 1 | ResellerOS cart + billing is PRIMARY for a customer's **first** purchase of domain and hosting | "cart and billing of ResellerOs will be as primary … when buying the domain and hosting" |
| 2 | DMS keeps its cart for purchases made **from inside the customer panel** | "When customer buys something from inside the customer panel itself Then we will use the cart flow of DMS itself" |
| 3 | **DMS issues no bills.** Every bill comes from ResellerOS; DMS holds a copy as reference | "DMS does not do its own billing anymore. Period. … no duplicate bills or different number series needed." |
| 4 | **Renewals are ResellerOS's.** DMS only fetches and shows the renewal bill | "Renewals subscription will be handled by ResellerOS. Period. Our DMS will only fetch that renewal bill from ResellerOs and show it." |
| 5 | DMS's token-based recurring charging is **disabled, not deleted** | "Use the ResellerOs system compelely. DMS token based system will be disable for now. Until we need it someday later" |
| 6 | No migration of existing DMS customers/mandates is needed | "Everything was in testing mode. No live customers at DMS" |
| 7 | **Hosting prices come from ResellerOS only.** DMS's hosting prices are disregarded | "Use the prices of hosting set in ResellerOS completely. Ignore and disregard the prices of DMS from now on" |
| 8 | **DMS has no public pages.** ResellerOS's frontend is the one in use; in-panel buying is small dialogs inside the DMS panel | "Remove the frontend pages of DMS completely since we are using the frontend page of ResellerOS now" · "Build inner small models to be able for user to purchase hosting and domain when inside the customer panel. Then remove those full fledged pages." |
| 9 | DMS's `/data-deletion` is removed too | answered "Remove it" when told ResellerOS has no equivalent and Facebook login may want one |
| 10 | **Production DMS is not touched yet** — local only until a production ResellerOS address is given | answered "Local only for now" |
| 11 | **Hosting prices exclude GST; 18% is added on top**, as ResellerOS does. A Starter year is ₹600 + ₹108 = ₹708 everywhere | "Reseller Os is correct price one. use that" |
| 12 | **ResellerOS's Razorpay account takes all the money**, including purchases made inside the DMS panel | chose "ResellerOS's account" |
| 13 | **DMS shows ResellerOS's own PDF** for a bill; it renders no bill of its own | chose "ResellerOS's own PDF" |
| 14 | **Production ResellerOS address: `https://reselleros.anutech.in`** (DMS's `NEXT_PUBLIC_RESELLEROS_URL`) | chose it |
| 15 | **Remove DMS's dead Admin → Page management controls** (deleted pages' visibility, homepage design) | chose "Remove them" |
| 16 | **If ResellerOS is down during an in-panel purchase: take the payment, bill later.** DMS queues the bill request and retries; the panel shows "bill being prepared"; a stuck one alerts the owner | chose "Take payment, bill later" |
| 17 | **Remove DMS's three admin invoice actions** (re-sync invoice, invoice retry, issue-invoice worker); bill problems are handled in ResellerOS | chose "Remove them" |
| 18 | **Pause DMS's `tokens-charge-recurring` Cloud Scheduler job** in production | chose "Yes, pause it" |

**The one price source (decision 7):** `LANDING_PLANS` in
`production/src/site/lib/data/hosting-landing.ts` — Starter ₹49.99, Standard ₹125, Plus
₹187.20 per month on yearly billing (yearly total = 12×, monthly billing = 2×). The public
pages, the catalogue sync and the cart's server-side re-pricing all read it. DMS's
`hostingplans` prices (monthly `renewalPrice`, no billing-period field) are not an input to
anything any more. If the two ever disagree, ResellerOS is right by definition.

Consequence of 2 + 3 together: an in-panel DMS cart purchase must still get its **bill from
ResellerOS**. DMS's cart stays, DMS's invoice numbering does not.

### Decisions 12–18 — the questions as asked, and Pardeep's answers (24 Sep 2026)

Asked in two rounds. Recorded with the options that were offered, so a later reader can see
what was chosen **against** what, not just the result. The recommendation marker is kept
because it shows which answers followed advice and which overrode it.

**Round 1**

| # | Question as asked | Options offered | Pardeep's answer |
|---|---|---|---|
| 12 | Which Razorpay account should take the money for hosting and domain sales, including purchases made inside the DMS panel? | ResellerOS's account *(recommended)* · DMS's account · Same account already | **ResellerOS's account** |
| 13 | When a customer opens their bills inside the DMS panel, what should they see? | ResellerOS's own PDF *(recommended)* · DMS's own view of the same numbers | **ResellerOS's own PDF** |
| 14 | Production DMS still serves its old public pages until it's deployed with the ResellerOS address. What is the production ResellerOS address? | `https://reselleros.anutech.in` · Not decided yet | **`https://reselleros.anutech.in`** |
| 15 | DMS's Admin → Page management still has visibility switches for the deleted pages and a homepage-design switch. They do nothing now. What should happen to them? | Remove them *(recommended)* · Leave them | **Remove them** |

**Round 2**

| # | Question as asked | Options offered | Pardeep's answer |
|---|---|---|---|
| 16 | When a customer buys inside the DMS panel, the bill now comes from ResellerOS. If ResellerOS is down at that moment, what should DMS do? | Take payment, bill later *(recommended)* · Block the purchase | **Take payment, bill later** |
| 17 | DMS has three admin invoice actions: re-sync invoice, invoice retry, and the issue-invoice worker. Once DMS stops issuing bills, what should they do? | Become "fetch from ResellerOS" *(recommended)* · Remove them | **Remove them** — against the recommendation. Bill problems are handled in ResellerOS; DMS keeps no repair button of its own. |
| 18 | DMS's nightly `tokens-charge-recurring` job in Cloud Scheduler is already a no-op. Should I also pause the job in production? | Yes, pause it *(recommended)* · Leave it running | **Yes, pause it** |

**Earlier answers the same day, recorded here with their wording for completeness:**

| # | Question / prompt | Pardeep's answer |
|---|---|---|
| 8 | (instruction) | *"Remove the frontend pages of DMS completely since we are using the frontend page of ResellerOS now"* |
| 8 | DMS's shop pages are also how a signed-in customer buys from inside the panel — what should happen to them? (Remove and send to ResellerOS · Keep them for the panel) | *"Build inner small models to be able for user to purchase hosting and domain when inside the customer panel. Then remove those full fledged pages."* |
| 9 | Facebook login needs a data-deletion page; ResellerOS has none. (Keep DMS's page · Remove it) | **Remove it** |
| 10 | Which address should production DMS redirect to? (reselleros.anutech.in · Local only for now) | **Local only for now** — superseded by decision 14 above |
| 11 | DMS reads ₹49.99/month as GST-inclusive, ResellerOS adds GST on top (₹599.88 vs ₹708). Which is right? | *"Reseller Os is correct price one. use that"* |
| — | Protected area | *"This part of ResellerOs cannot be edited or touched by our any edits … being worked on by my collegue"* → AGENTS.md §13 |
| — | Shared money logic behind it | *"block it for now. If need to edit, Ask me and i will ask my collegue"* → added to the guard |

### Decisions 19–21 — enabling the ResellerOS cart (24 Sep 2026)

Asked after finding that 6 of the site's add-to-cart buttons send no SKU (so checkout refuses
them), that a domain line loses the actual domain name, that a paid domain is not queued for
anyone, and that the domain search shows a live price while checkout charges a fixed table.

| # | Question as asked | Options offered | Pardeep's answer |
|---|---|---|---|
| 19 | The domain search shows the live ResellerClub price (via DMS), but checkout charges a fixed price table in ResellerOS's code. Which should checkout charge? | Live price, re-checked *(recommended)* · Fixed price table | **Live price, re-checked** — the server re-fetches the price the customer saw; if unreachable, checkout refuses with a clear message instead of guessing |
| 20 | Google Workspace licences, Anutech Mail (monthly) and SSL certificates can be added to the cart but have no server-side price. What should those buttons do? | Send to a quote *(recommended)* · Make them payable in cart | **Send to a quote** — Workspace keeps its own direct-buy page |
| 21 | After a customer pays for a domain, what should happen? (registration spends real money and cannot be undone) | Staff registers it *(recommended)* · Register automatically | **Register automatically** — against the recommendation |

**How decision 21 is being built:** as its own change, AFTER the cart fixes, behind a switch that
is OFF until the owner approves a first real registration. Two open items it depends on are
still open: who is seller of record for an engine-sourced sale, and how a ResellerOS-only buyer
gets a ResellerClub customer account (§D below). Until the switch is on, a paid domain is
queued with its exact name, so nothing is lost.

### Decisions 22–24 — how automatic registration works (24 Sep 2026)

Asked while building decision 21, after finding that ResellerClub needs a registrant postal
address (the ResellerOS checkout collected none), that a ResellerOS buyer has no DMS account
to manage the domain from, and that nothing capped automatic spending.

| # | Question as asked | Options offered | Pardeep's answer |
|---|---|---|---|
| 22 | Whose details should the domain be registered under? | Customer's, add address *(recommended)* · ANUTECH's own details | **Customer's — checkout collects the address** |
| 23 | Should a DMS account be created for the buyer? | Yes, create one *(recommended)* · No account | **Yes — found or created by email.** Corrected the same day: the option text said the customer "reaches it by the SSO hand-off", but ResellerOS has no customer portal to hand off FROM. So the engine sends a "set your password" email at creation, as DMS's guest checkout does (`engine-customer.ts`) |
| 24 | What limit should automatic registration have? | Per-domain + daily cap *(recommended)* · Per-domain checks only · Human release every time | **Per-domain + daily cap** — live payment, paid ≥ ResellerClub cost, and under a daily count + ₹ cap; anything else waits for a person. No figures were given, so it ships at **5 per day / ₹10,000 per day**, set by env |

### Decision 26 — only Starter has a free hosting trial (24 Sep 2026)

Pardeep: *"we only offer free trial for Starter plan for both monthly and yearly … No other
plans is eligible for free trial."* **Built.** One rule, `lib/hosting/trial-plan.ts`, read in four places:
- **/hosting:** Starter keeps "Start free trial". Standard and Plus show "Buy" plus a "Try Starter
  free" link.
- **The trial form:** the plan picker is gone. `?plan=plus` gets a note and a buy link.
- **The trial API:** refuses any other plan with a 400 that says what to do instead.
- **The confirm route:** never provisions a Standard/Plus trial from an older lead. The owner
  is told to offer Starter or a paid plan. The unknown-plan fallback to Standard is removed.

Verified:
- test-verified by `trial-plan.test.ts`;
- browser-verified on the dev server: page HTML, the `?plan=plus` form, and a POST with
  `tierId:"plus"` refused.

**DMS, same rule (DMS `19c1134a`):** the panel's Buy-hosting dialog already offered the trial on
Starter alone, but no server check looked at the plan. The eligibility check and create-order now
refuse any other plan.
- [x] **Monthly Starter trial in the DMS panel — BUILT (Pardeep: "Yes add that too"), DMS `47f0a81a`.**
  - **Dialog:** offers the Starter trial on both toggles.
  - **Hosting record:** remembers its cycle in a new optional `Hosting.billingCycle`. When it is
    absent the hosting renews yearly, so every existing row renews exactly as before.
  - **`renew` and `renew-info`:** charge and quote one month for a monthly hosting. The renewal
    dialog now says "1 Month Extension".
  - **Checkout:** shows the post-trial price for the trial's own cycle. It also no longer claims
    the card is "saved for automatic yearly billing". That was false for every trial: the only
    trial path running takes no card.
  - **Where it is refused:** a monthly trial is refused wherever a YEARLY mandate or subscription
    would be set up (`HOSTING_MANDATE_FLOW=tokens` with DMS subscriptions on). It is never
    silently billed for a year.

  **test-verified only.** Not tried in the running panel: the container still runs the previous
  build, and it needs a signed-in customer.

### Decision 25 — hosting goes through the DMS engine (24 Sep 2026)

| # | Question as asked | Options offered | Pardeep's answer |
|---|---|---|---|
| 25 | Which app should create the hosting account after a customer pays on ResellerOS? | DMS engine *(recommended)* · ResellerOS worker (exists) | **DMS engine** — DMS stays the only app writing to DirectAdmin for a sale, and the hosting lands in the customer's DMS panel |
| — | How should it be verified, with no DirectAdmin reachable locally? | Tests now, real run later *(recommended)* · A test DA server | **"Will use the live DA for testing. Don't worry, will delete those testing hostings later on."** Also: ResellerClub is out of scope locally ("needs a whitelisted static single IP") |

### Waiting on Pardeep — actions only he can take

- [ ] **Pause `tokens-charge-recurring` (decision 18).** The Google Cloud CLI is not installed on
      the development machine, so it could not be done from here. Run where `gcloud` is logged in:
      `gcloud scheduler jobs pause tokens-charge-recurring --location=asia-south1 --project=speedy-unison-453807-e9`
      — undo with `resume`. Harmless until then: the code gate (DMS `8bf941e`) stops it charging.
- [ ] **Confirm `MAX_MANDATE_AMOUNT` with Razorpay** before the first live UPI Autopay mandate. The
      per-debit cap cannot be raised after a customer approves it.
- [ ] **Cancel any leftover DMS test subscriptions** in the Razorpay dashboard. DMS no longer creates
      them (DMS `06a9546`), but ones created before still carry the old ₹599.88 amounts.
- [ ] **Say go for the ResellerOS production migrations.** Two are applied to LOCAL only:
      `20260921100000_provisioning_facts_are_immutable` (deferred 23 Sep, §0.1) and
      `20260924120000_provisioning_one_per_product` (24 Sep). Both must be live before the
      matching code deploys — the second especially: the webhook now writes one provisioning
      row per product, and under the old index a paid domain in a domain + hosting cart would
      again be queued for nobody.
- [ ] **Test a real payment** on the ResellerOS cart (you said you would do the payment part).
      Not verifiable here: no Razorpay keys locally, and the domain registry does not answer
      this machine, so a live domain price has never been observed by the new checkout.

### Ready to build — each waits for a go-ahead

1. **In-panel DMS payments onto ResellerOS's Razorpay account** (decision 12).
2. **Bill hand-off with the "bill later" queue** (decisions 13, 16): after payment DMS asks
   ResellerOS for the bill; if unreachable it queues and retries, the panel shows "bill being
   prepared", a stuck one alerts the owner, and the panel then serves ResellerOS's PDF. Built in
   the SAME change that stops DMS issuing invoices and removes the three admin invoice actions
   (decision 17) — so there is never a window with two invoice issuers or none.
3. **Remove the dead Admin → Page management controls** in DMS (decision 15).
4. **Deploy production DMS** with `NEXT_PUBLIC_RESELLEROS_URL=https://reselleros.anutech.in`
   (decision 14). Only on an explicit go: it switches production's public pages over to
   ResellerOS. Before it, update any Razorpay-registered policy URLs that point at DMS's domain.
5. ~~Automatic domain registration after payment~~ — **built 24 Sep, switched off.** See
   "Shipped" below for what it does and the eight steps before switching it on.

### Why decision 5 was a safety change, not tidying

The two apps collect renewals with different Razorpay instruments:

- **ResellerOS** — Razorpay **Subscriptions** (UPI Autopay / e-NACH), `payment_mandates`,
  `lib/payments/mandate.ts`. Razorpay fires each debit; ResellerOS cannot initiate one.
- **DMS** — Razorpay **Tokens API**. DMS fires each debit itself (`chargeViaToken`,
  cron `tokens-charge-recurring`, daily 22:00 UTC).

Both running means two independent systems able to collect the same renewal. DMS dedups on
`(hostingId, dueDate)` inside its own Mongo and knows nothing of ResellerOS, so a double debit
would be caught by nothing on either side — the customer would be the detector.

Two facts worth keeping for when real customers exist: a mandate cannot be moved between
instruments silently (each needs fresh customer approval), and a UPI Autopay per-debit cap
cannot be raised after approval — so `MAX_MANDATE_AMOUNT` in ResellerOS must be confirmed
with Razorpay before the first live mandate.

### Shipped 24 Sep 2026

- [x] **DMS `8bf941e` — tokens recurring charging gated OFF.** Gate is inside
      `chargeRecurringHosting` (the chokepoint, so `scripts/charge-recurring-hostings.js`
      cannot walk round it — L65), placed **before** any Razorpay call, returns `skipped`
      rather than throwing (a disabled feature is not a failed night — L6), and is off unless
      `DMS_TOKEN_RECURRING_ENABLED === "1"` exactly (fails closed — L41). Nothing deleted: the
      dedup claim, abandon-on-first-failure and yearly/monthly inference all stay.
      Pinned by `tests/unit/lib/services/payment/recurring-charge-disabled.test.ts` (8 tests,
      red-checked). The 23 existing tests in `recurring-charge-service.test.ts` opt in via the
      env var in `beforeEach`. **test-verified.** DMS gate after the change:
      **6,617 tests / 442 files, zero failures.**
- [x] **ResellerOS shop gate — built (`32a454af`) and REVERTED (`0fc35259`) the same day.**
      Pardeep first chose DMS as the shop, then reversed to decision 1 above. Recorded here so
      nobody finds the commit in history and rebuilds it: the ResellerOS shop is **open and
      primary**. DMS's `/hosting` page visibility is back to `draft` locally.
- [x] **DMS public pages deleted; in-panel purchase dialogs built (decisions 8-10).** Gone:
      `/`, `/about`, `/contact`, `/privacy`, `/terms-and-conditions`, `/cancellation-refund`,
      `/data-deletion`, `/hosting`, `/domains-home`, `/domains/search`,
      `/domains/bulk-search`, `components/marketing/`. Each URL is now a 307 to its ResellerOS
      page, for every visitor, admins included (the old "admin still sees DMS's copy" rule
      had nothing left to show). Kept: cart, checkout, login, SSO, the panel, and
      `/hosting/error` (the control-panel SSO failure page, not marketing).
      Panel: "Buy hosting" / "Register domain" in the sidebar, and every empty-state button,
      open `?buy=hosting` / `?buy=domain` dialogs. They feed DMS's own cart unchanged: the
      hosting lines are the old page's logic moved verbatim, and the domain dialog is the same
      `DomainSearch` component. Three panel "Search Domains" buttons had been sending
      customers to `/`, i.e. off to ResellerOS, and now open the dialog.
      Guard: `scripts/deploy-cloud-run.sh` refuses to build without
      `NEXT_PUBLIC_RESELLEROS_URL` and now passes it to both build paths, so production
      cannot lose its policy pages to a 404 by accident. **test-verified:** DMS
      6,676 tests / 444 files green, typecheck clean, lint 0 errors; the link scan and the
      deploy guard were each red-checked. DMS `0fe6c95`. **browser-verified, local:** all 11
      deleted URLs 307 to the right ResellerOS page; `/cart`, `/login`, `/hosting/error` still
      200; sidebar → Buy hosting → Add to cart → `/cart` shows Starter Hosting at ₹599.88; the
      domain dialog opens pre-filled and searches by itself. Adding a domain to the cart was NOT
      verifiable locally: ResellerClub's API does not answer from this machine, same as before
      the change.

### Still to build (not started — each waits for a go-ahead)

- [ ] **Stop DMS issuing invoices.** Gate `lib/services/billing/createPrimaryInvoice.ts` (the
      only caller of `allocateInvoiceNumber()`; 10 flows reach it). **In the same commit**
      neutralise the legacy pre-save hook in `models/Order.ts` (~line 541) that mints
      `INV-${timestamp}-${random}` when `status === "completed" && !invoiceNumber &&
      invoiceProvider !== "primary"` — gating the first alone makes the second fire MORE
      (L112 shape). Needs a scan test that both are closed.
- [ ] **New engine command `billing.record_external_invoice`.** DMS stores ResellerOS's invoice
      number and PDF link as a foreign reference. Touches no DMS `Counter`, idempotent on the
      ResellerOS invoice number.
- [x] **Historical `TI/…` invoices — NOT NEEDED. USER DECISION, Pardeep, 24 Sep 2026:** every
      DMS invoice so far was issued in testing, so there is no GSTR-1 history to preserve.
      Do not build anything to keep them reportable.
- [x] **DMS charges hosting at ResellerOS's price + GST (decisions 7 and 11).** One function,
      DMS `lib/pricing/hosting-price.ts`, is ResellerOS's cart formula; every DMS hosting
      charge reads it: the panel dialog, `create-order` (member and guest, now re-priced on
      the server — before this both charged whatever price the browser sent), `/renew`,
      `/renew-info`, `/upgrade`, `/upgrade-info` and the expiry worker. A plan ResellerOS does
      not price is refused, never guessed. A cart holding the old figure gets `409
      PRICE_CHANGED` with the new one. DMS no longer opens Razorpay Subscriptions for hosting
      (their plans hard-code yearly = 12 × monthly, and renewals are ResellerOS's): paid hosting
      is one payment for its period, trials take the no-mandate flow. Fixed on the way, both
      customer-visible: the expiry worker emailed yearly renewals at the per-MONTH figure
      (₹49.99 for a year), and fell back to Starter's price for unknown plans.
      DMS `06a9546`. **test-verified:** 6,702 tests / 445 files; 25 go red if the GST is
      removed. **browser-verified, local:** dialog ₹600→₹708 · ₹1,500→₹1,770 · ₹2,246→₹2,650
      yearly and ₹118 · ₹295 · ₹441 monthly; cart Subtotal ₹600 · GST ₹108 · Total ₹708; the
      running server refuses ₹599.88 with `409 PRICE_CHANGED`. A successful payment was NOT
      run, because that creates a Razorpay order.
- [ ] **DMS still holds a COPY of ResellerOS's hosting prices** (`config/hosting-plans.ts`,
      pinned equal to `LANDING_PLANS` by a DMS test). Reading them over the engine API would
      remove the copy.
- [ ] **Existing DMS Razorpay hosting plans and subscriptions** (`hostingplans.razorpayPlans`)
      still carry the old amounts. DMS no longer creates new ones, and there are no live
      customers (decision 6), but any test subscription left in the Razorpay dashboard should
      be cancelled there.
- [ ] **Remove the dead Admin → Page management controls in DMS (decision 15).** Visibility
      toggles for the deleted pages and the homepage-design switch change nothing now.
- [ ] **Production DMS still has its old pages.** Deploying needs
      `NEXT_PUBLIC_RESELLEROS_URL=https://reselleros.anutech.in` (decision 14) in `.env.local`,
      because the deploy refuses without it. Before that deploy, update the
      policy URLs registered with Razorpay if they point at DMS's domain: they will now 307.
- [x] **Automatic domain registration (decisions 21-24) — BUILT, SWITCHED OFF.** 24 Sep 2026.
      **DMS** (engine `domain.register`, Phase 9): `lib/integrations/engine-handlers-register.ts`
      + pure rules in `engine-register-policy.ts`. Order: validate → already in our reseller
      account? (this customer → done with no spend; another → held) → ResellerClub cost
      (stale cache refused) + last-24h usage → **test mode stops here and reports** → spend
      decision (live payment, paid ≥ cost, ≤ 5/day, ≤ ₹10,000/day — env
      `ENGINE_DOMAIN_REGISTER_MAX_PER_DAY` / `_MAX_RUPEES_PER_DAY`) → DMS account + RC
      customer/contact (found or created by email) → register (a lost response is
      `sent_unknown` and HOLDS the lock; balance-pending too) → Domain row on the customer's
      account. Reconciler: "in our account, owned by this customer". Live only behind its OWN
      gate `ENGINE_DOMAIN_REGISTER_LIVE=1` — flipping it puts nothing else live. The route now
      returns the handler's sentence as `detail`, so a hold is readable on the first answer.
      **ResellerOS:** checkout asks for the registrant's address when the cart holds a domain
      (server-validated, 6-digit PIN) and records the registrant on the domain line;
      `lib/dms-engine/commands.ts` (write client, `DMS_ENGINE_COMMAND_KEY`); worker
      `/api/cron/register-domains` (gate `DOMAIN_REGISTRATION_LIVE=1`, workspace kill switch,
      one command id per request per IST day so re-runs replay); the webhook approves a paid
      domain row only when that gate is on.
      **test-verified:** DMS 29 handler/policy tests (spend guard red-checked: 4 fail without it)
      + updated engine tripwires; ResellerOS 11 worker tests (kill switch red-checked), 22
      client/helper tests, 4 new checkout-route tests. Gates: ResellerOS 6,702 / 364, DMS
      6,732 / 446, typecheck + lint clean in both. **browser-verified, local:** the address
      fields appear only with a domain in the cart, the hosting domain pre-fills, Continue stays
      disabled until the address (incl. a 6-digit PIN) is complete. **NOT verified:** any call to
      ResellerClub — it does not answer this machine — and the engine was not exercised through a
      running container.
- [ ] **Before switching automatic registration on — in this order:**
      1. Apply both ResellerOS migrations to production (see "Waiting on Pardeep").
      2. Deploy both apps with this code.
      3. Set the keys: ResellerOS `DMS_ENGINE_COMMAND_KEY` = DMS `BILLING_COMMAND_API_KEY`
         (production DMS has no value for it yet, by design until now), and `DMS_ENGINE_URL`.
      4. Top up the ResellerClub reseller balance — an unfunded registration is held.
      5. On the Automation page, set **provisioning.activate** to auto; otherwise every paid
         domain is queued with a blocker and the worker never sees it.
      6. Create a Cloud Scheduler job for `/api/cron/register-domains` (Bearer `CRON_SECRET`),
         **with** a retry count (L1: a retryConfig without `retryCount` is zero retries). Safe to
         retry: the command id is stable per day.
      7. Run one `domain.register` in `mode:"test"` against production for a real paid order and
         read the answer: availability, cost, cap, account. That is the "first real
         registration" approval.
      8. Then set `ENGINE_DOMAIN_REGISTER_LIVE=1` on DMS and `DOMAIN_REGISTRATION_LIVE=1` on
         ResellerOS.
      Rows paid BEFORE step 8 keep the `engine_not_connected` blocker and are never picked up
      automatically — register those by hand.
- [x] **Hosting provisioning through the DMS engine (decision 25) — BUILT, SWITCHED OFF.** 24 Sep.
      **DMS** `hosting.provision` (`engine-handlers-provision.ts`), unblocked by decision 23: the
      buyer's DMS account is found or created (`engine-customer.ts`, shared with
      `domain.register`) with a "set your password" email. The DirectAdmin package comes from the
      catalogue. **Usernames are deterministic per domain** (DMS's other provisioners pick them at
      random, so a retry after a lost response would create a SECOND account): DirectAdmin is read
      first — an account already on this domain is ADOPTED, one on another domain moves to the
      next candidate, only a free name is created. Reconciler asks the same question. Its own gate
      `ENGINE_HOSTING_PROVISION_LIVE=1`; a test-mode payment is held.
      **ResellerOS** `/api/cron/provision-hosting` REWRITTEN: it no longer calls DirectAdmin or
      emails a cPanel password — it sends `hosting.provision` (gate `HOSTING_PROVISIONING_LIVE=1`,
      kill switch, day-keyed command id). The checkout records the hosting line's plan and months.
      The webhook approves a paid hosting row on that gate instead of this app's own DA creds.
      **test-verified:** DMS 18 provision tests (adopt-on-retry red-checked: 2 fail without it), the
      engine tripwires moved (every known command now has a handler); ResellerOS 9 worker tests +
      helpers. Gates: ResellerOS 6,713 / 365, DMS 6,750 / 447, typecheck + lint clean.
      **Verified LIVE on 24 Sep 2026** against `server1.anutech.in:2222`, using a new key from Pardeep
      and a local override that lives only in the session scratchpad (the committed config still
      points DirectAdmin at the placeholder):
      1. test mode: DirectAdmin read, "would create `rsospf34b2`, package Starter", nothing written;
      2. live: account `rsospf34b2` created on `rsosprovtest2409.in`, package Starter, IP
         35.207.233.155, plus the DMS account and hosting row;
      3. same commandId: replayed, nothing ran;
      4. new commandId: DMS already had the hosting row, no second account. DirectAdmin afterwards
         lists exactly one user.
      **Not exercised live:** the adopt-from-DirectAdmin path, where DMS has no row but the DA
      account exists (a lost response). Running it needed a hosting row deleted locally and was
      not done; unit tests only.
      **The live run found two DMS bugs, fixed in DMS `23680de9`:**
      - `createPackage` sent `action=create`, which DirectAdmin reads as a LIST request, so it had
        never created a package.
      - `unwrapDAError` dropped DirectAdmin's reply text, so a user that does not exist read as
        "Unknown DirectAdmin error" and every provision refused (safely).
- [ ] **DELETE the test account** (Pardeep: "will delete those testing hostings later on"):
      DirectAdmin user `rsospf34b2` / `rsosprovtest2409.in` on server1. Locally there are also a DMS
      user `rsos-provision-test@example.invalid` and its hosting row.
- [ ] **server1 is not the server DMS's config describes. Check before any production hosting
      sale.** Measured 24 Sep 2026: server1.anutech.in has IP **35.207.233.155**, and before this test
      it had **no packages, no users and no resellers**. In July the same hostname answered on
      **34.93.167.160** and held live accounts (`testi5491c`, `ramushamu`, DMS TASKS.md L229/L311).
      Production DMS still has `DIRECTADMIN_IP=34.93.167.160`, and so does the fallback in
      `lib/directadmin/client.ts:41`. Against this box a create would probably fail with "That IP
      does not exist in your list" (the July failure; not re-tested). Customers' existing hosting
      rows in DMS may point at DA accounts that are not on this box. Not changed: the owner has to
      say which server is the real one. Three packages (Starter 10 GB, Standard 25 GB, Plus 50 GB;
      sites 1 / 5 / unlimited) were created on it for this test, so Packages Available is no
      longer 0.
- [ ] **The hosting TRIAL still writes to DirectAdmin from ResellerOS** (`api/public/trial/hosting/
      confirm` → `daCreateAccount`, gated by `HOSTING_TRIAL_LIVE`). A second writer, left as is —
      move it onto `hosting.provision` when trials are next touched.
- [ ] **Before switching hosting provisioning on:** production migrations, deploy both apps, set
      `DMS_ENGINE_COMMAND_KEY`/`DMS_ENGINE_URL`, `provisioning.activate` on auto, a Cloud Scheduler
      job for `/api/cron/provision-hosting` with a retry count, one test-mode run, then
      `ENGINE_HOSTING_PROVISION_LIVE=1` on DMS and `HOSTING_PROVISIONING_LIVE=1` here. Rows paid
      earlier keep their blocker and are set up by hand.
- [ ] **No customer email yet on registration.** The domain appears in the customer's DMS panel,
      and the owner is alerted on a lost response or a refusal. A "your domain is registered"
      email to the customer is an automated customer send, so it needs its own action on the
      automation registry (L62-L65) — not added in this change.
- [x] **ResellerOS cart enabled properly (decisions 19-20), 24 Sep 2026.** The line above said
      "v1 knows hosting SKUs only" — stale: domains were priced, but from a fixed table while the
      search showed the live price. Found and fixed together:
      · 6 site add-to-cart buttons sent no SKU, so checkout refused them at payment. Domain lines
        now carry `sku` AND the exact `domain`; Workspace / Anutech Mail / SSL buttons go to a quote.
      · A domain line kept only its TLD ("Domain .com"), so nobody knew WHICH name was paid for.
        It now carries the name, validated (`lib/domains/live-lookup.ts` `splitDomain`).
      · Domains are charged the live price, re-checked at payment from the same module the
        search uses (`lookupDomains`); unreachable / taken / unpriced → refused, never guessed.
      · The cart page applied coupons ANUTECH10 / MIGRATE15 to the total it SHOWED; the server
        ignored them, so a coupon user was charged more than shown. Server now applies the same
        table; checkout compares its total with the shown one and asks before charging a
        different figure (reusing the same order, so no second quote number).
      · Rate-card rows added placeholders `yourname.<tld>` / `yourbusiness.<tld>`; now "Search".
      · A domain-only cart was labelled `cart-order` and filed as vendor `other`; now
        `domain-registration`. Hosting defaults to the domain bought in the same cart.
      · After payment only ONE provisioning request per quote was allowed, so in a domain +
        hosting cart the domain was queued for nobody. Migration
        `20260924120000_provisioning_one_per_product` + `lib/provisioning/products.ts`: one
        request per product, re-delivered events still refused (SQL test
        `provisioning_one_per_product`, red-checked against the old index).
      **test-verified:** 11 route tests, 6-test source scan that every site cart add carries a
      sku (red-checked), products + splitDomain units, SQL test. **browser-verified, local:**
      email/SSL → quote, rate card → Search with no cart add, hosting line ₹600 with sku,
      coupon shown ₹540, checkout passes pricing (stops at "payment not set up" — no local keys),
      a domain line refused honestly ("couldn't reach the domain registry"), an old SKU-less
      Workspace line refused. **NOT verified:** a live domain price and a real payment — the
      registry does not answer this machine and there are no local Razorpay keys.
- [ ] **Apply migration `20260924120000_provisioning_one_per_product` to production** — applied
      to LOCAL only. Must be live before the new webhook code deploys: the webhook now inserts
      one row per product, and under the old one-per-quote index the second row would fail
      (logged, not thrown — but the domain would again be queued for nobody).
- [ ] **Two dead components hold SKU-less adds:** `DomainRateCard`, `HostingPlans` (replaced
      2-3 Sep, unmounted since). Pinned unmounted by `src/site/cart-lines-priceable.test.ts`;
      delete them when convenient.

- [ ] **In-panel DMS purchases pay into ResellerOS's Razorpay account (decision 12).** DMS's
      checkout currently uses DMS's own keys. Moving it means ResellerOS creates the Razorpay
      order and receives the webhook, or DMS is given ResellerOS's keys. Design this together
      with the bill hand-off below.
- [ ] **Bill hand-off with an offline queue (decisions 13 and 16).** After payment DMS asks
      ResellerOS for the bill; if ResellerOS is unreachable it queues and retries (L1: say what
      retries it, who is told, and how a stuck one is noticed a week later). The panel shows
      "bill being prepared" until the ResellerOS PDF arrives, then serves that PDF.
- [ ] **Remove DMS's three admin invoice actions (decision 17)** in the same change that stops
      DMS issuing invoices: re-sync invoice (`api/admin/orders/[id]/re-sync-invoice`), invoice
      retry (`lib/invoice-retry.ts` + its pill), and the issue-invoice worker
      (`api/workers/issue-invoice`).
- [ ] **Pause `tokens-charge-recurring` (decision 18)** — the owner's to run; command under
      "Waiting on Pardeep" above.

### Open questions for Pardeep

- [x] Which Razorpay account takes the money? **ResellerOS's (decision 12).**
- [x] One bill or two? **DMS shows ResellerOS's own PDF (decision 13).**
- [x] ResellerOS down during an in-panel purchase? **Take payment, bill later (decision 16).**
- [x] DMS's three admin invoice actions? **Removed (decision 17).**
- [x] **Is a hosting price GST-inclusive or not?** Answered 24 Sep: ResellerOS's reading —
      GST on top (decision 11). Built the same day, see above.
- [x] Production ResellerOS address? **`https://reselleros.anutech.in` (decision 14).**
- [ ] Confirm `MAX_MANDATE_AMOUNT` with Razorpay (see above).
- [x] Pause the `tokens-charge-recurring` job? **Yes (decision 18); the command is in the build list above.**

---

## 0. What is left — measured 2026-09-23 (refreshed after Phase 8)

> **Older than §0A.** This section was measured on 23 Sep. The 24 Sep decisions and builds in
> §0A come after it and win where they disagree — notably DMS no longer being the invoice
> issuer (decision 3), which changes the seller-of-record entry below.

Everything below is verified against the code today, not carried forward. Where an older
entry in this file disagrees, **this section is the measurement** and the older one has been
corrected in place. Grouped by who can move it, because most of what remains is not code.

### 0.1 Yours — six decisions, and one thing to run

Ordered by what they unblock. Only the first two are urgent; the rest gate Phase 9, which is
not started.

- [ ] **Apply ResellerOS migration `20260921100000` to production.** Deferred 23 Sep at your
      direction; local is verified (§0.2). Until it runs, a tenant member can flip
      `payment_mode` from `test` to `live`, clear `blocker`, and have the worker provision real
      hosting against a payment that settled zero rupees. One file, and I can run it the way I
      ran DMS 008.
- [ ] **What shape should the engine's spend control take?** The newest blocker, and now the
      *only* thing keeping `domain.renew` switched off — its other risks are handled. Nothing
      caps how many money-spending commands a caller can trigger. Per tenant, per day, a rupee
      total, or a human release per row. **This also gates Phase 9**, so it is the highest-value
      answer on this list.
- [ ] **Domain renewal retail pricing.** Blocks the customer-facing renewal checkout (not the
      engine command). No retail renewal price exists anywhere — `getRenewalPricing` returns the
      registrar's COST. Nothing was invented, so the modal routes to support.
- [ ] **Does an engine-provisioned hosting account get a DMS portal user?** Blocks
      `hosting.provision`. DMS mints a `Math.random()` password it never returns because its
      customers arrive by SSO, so without a portal user there is no way in and provisioning
      still reports success. My recommendation: yes, create the portal user.
- [ ] **Who is the seller of record for an engine-sourced sale?** Blocks Phase 9. **Partly
      answered 24 Sep:** ResellerOS issues every bill and takes the money into its Razorpay
      account (decisions 3 and 12), so ResellerOS is the issuing side. What still needs the CA:
      confirming that for GST, and how credit notes work once DMS stops issuing. The line this
      replaced said "DMS's GST engine is permanent and ungated" — true until decision 3 is built.
- [ ] **How does a ResellerOS-only buyer get a ResellerClub customer?** Blocks Phase 9.
      `registerDomain` needs a numeric `customerId`; contacts come from a private helper inside
      DMS's payment pipeline.
- [ ] **Which side owns DirectAdmin?** Lowest urgency of the six. It did not block Phase 7 in
      the end.

### 0.2 Mine

**Shipped 2026-09-23** (all test-verified and reasoned-only — no provider has been contacted,
live is still hard-disabled in code):

- [x] **Phase 8 — `domain.renew`.** `expiryBefore` required and sent verbatim, turning RC's own
      `exp-date` into a working idempotency key; an already-renewed domain is refused before any
      money moves, and the same baseline is the reconciler, so no human release was needed.
      Performable, deliberately not live-eligible.
- [x] **Per-command live control (code half).** `LIVE_COMMANDS_ENABLED` predated four
      provider-touching handlers, so flipping one constant would have armed everything including
      `domain.register`. Eligibility is now per command and silence means no.
- [x] **The renewal route's retry-inviting 500**, plus a false failure it was hiding: a
      bookkeeping throw after a successful renewal reported the renewal as failed, which is how a
      customer buys a second year.
- [x] **The renewal expiry gap.** The canonical source is the Domain collection; nothing updated
      it, so `daily-scheduler` kept chasing renewed domains. Expiry read from RC, never computed.
- [x] **Transport wiring.** Phase 4's catch recorded `not_sent` unconditionally; Phase 6 made
      that false. A write that dies in flight now holds its claim.
- [x] **DMS migration 008 applied to production**, and the Windows ESM bug in the migration
      runner that made it fail first (L110).
- [x] **ResellerOS migration verified on local Supabase** — checked in `pg_proc`/`pg_trigger`,
      SQL test green, red-checked by dropping the trigger.

- [x] **The SQL suite was run for the first time in about a month — 48/54, now 53/54.**
      Those files are in neither CI nor the Stop hook (§9), so their claims age silently (L7).
      **Not one of the six failures was a product defect** — all six were fixtures:
      `portal_set_auto_renew` borrowed an auth user with `select id from auth.users limit 1`
      (the thing L11 forbids in those words; `customer_users.auth_user_id` is UNIQUE, so it
      passed on production only by luck of which row came back first); `subscriptions_item_id`
      hardcoded a production auth id AND inserted into the LIVE ANUTECH tenant;
      `quote_accepted_on_first_payment` and `txn_category_rules` chose `11111111-…`/`22222222-…`,
      which the local seed also chose for its real tenants. All four own their data now.
      `offsite_export` depended on the nightly cron having run — it owns its snapshots, and the
      newest-per-tenant rule is now MEASURED rather than assumed. `sandbox_tenant_isolation` is
      production-only by design and says `NOT APPLICABLE HERE` instead of dying on a foreign key.
      · **And it was missing a precondition.** Every case-1 assertion is "the tester sees ZERO
        rows of another tenant" — and zero is also what an EMPTY other tenant returns. L11
        records the day every transactional table in the live tenant was cleared; on that day the
        headline would have passed with nothing to find. It now counts what could leak first.
      · **One runner, not two.** I built a second one before checking — §11 exists to stop that.
        `scripts/test-sql.mjs` has been there since 29 Aug and is better. Mine is deleted; its two
        real additions are merged in: `npm run test:sql:local` (the old one needed a linked
        project and could not run at all locally, while §4a says work happens locally), and
        `NOT APPLICABLE HERE` as its own column.

- [x] **A customer confirming a hosting trial was redirected to a host that 503s** (`789b8011`).
      `https://resellersos.web.app` is dead — measured 23 Sep, and L91 measured the same a month
      earlier. L91 fixed the one function it was chasing and the pattern survived in **13** more
      files. Twelve build internal staff links; `api/public/trial/hosting/confirm` redirected the
      CUSTOMER. It now builds the redirect from the request's own origin — no configuration, and
      it survives this service having more than one hostname (L18).
      · **The other twelve are PINNED, not rewritten.** Latent (the Dockerfile bakes the var), and
        none of those 13 route files has a single test — L58 says extracting shared code out of an
        untested money-adjacent path is the risky option. `app-url-fallback.test.ts` fails on any
        new use AND on a stale entry, so the list cannot rot into a standing excuse.
      · DMS checked for the same shape: its only fallback host, `https://app.anutech.in`,
        answers 200. Clean.

- [x] **Lint and `npm run build` measured for both repos, for the first time.** §9 had said for
      both that they were NOT run and not claimed. That mattered: CI does not run on feature
      branches, so on this branch the local gate is the only gate, and a build was never in it.
      ResellerOS lint exit 0 (0 errors / 29 warnings), build exit 0. DMS lint exit 0
      (0 errors / 418 warnings), build exit 0. **Stop the dev server before building** — `next
      build` rewrites `.next` under the running server, and because DMS's front door redirects
      to ResellerOS, stopping the wrong one makes DMS look dead too.

**Still open, in order:**

- [x] **Domain TRANSFER — read end to end 2026-09-23, and MY ENTRY WAS WRONG.** It said the
      route "never writes a `Domain` row, so a transferred-in domain never appears in the
      customer's list". It does write the row, and the domain does appear. Not copying the
      renewal fix blind is the only reason that was caught.
      **The real finding is narrower and worse.** The row is saved with **no `expiresAt`**, so
      it gets no `next_action_at`, and `daily-scheduler` selects on `next_action_at <= now` — so
      a transferred-in domain is **never reminded before it expires**. And **nothing completes a
      transfer**: no cron, sweeper or route moves it off `status: "pending"`, and
      `pending-sweeper` watches `PendingDomain`/`PendingHosting`, not `Domain`, so it never sees
      the row.
      `appendUserDomain` is now DELETED — transfer was its last caller — and the marker moved
      into the route at the line it occupied. The route's test pins the absence of `expiresAt`
      so whoever builds completion sees what to fill in.

- [x] **Made VISIBLE 2026-09-23, and it is bigger than transfer.** `pending-sweeper` now
      watches the `Domain` collection (DMS `b53ac9a`).
      **The finding:** BOTH creation paths write `status: "pending"` with no `expiresAt` —
      `provisioner-domain.ts` for a registration and `api/domains/transfer` for a transfer — and
      nothing automatic advances them. `DomainVerificationService` does it properly (status AND
      expiry from RC), but only admin sync buttons and the customer's own sync button call it.
      So until somebody presses one, a domain has no expiry → no `next_action_at` →
      `daily-scheduler` can never select it → **no renewal reminder, ever**. That is every
      domain, not just transferred ones.
      A missing expiry is CRITICAL regardless of age (it is the half that costs the renewal); a
      stuck status WITH an expiry is a WARN. The digest row says to run the admin domain sync.
      Production holds 0 domains, so this is an exposure, not an incident.

- [ ] **Still to build: something that completes a domain automatically.** The sweeper reports
      the gap; it does not close it. `DomainVerificationService` already does the work and is
      already called by three admin routes — the missing piece is a scheduled caller, not new
      logic. Left undone deliberately: it needs a cadence decision and it calls ResellerClub,
      which is unreachable from here, so it cannot be proven locally.
      **Check `pending-sweeper` is actually scheduled first** — its header gives a Cloud
      Scheduler command as a *recommendation*, which is not evidence a job exists. If nothing
      runs it, the visibility added today is also theoretical (AGENTS.md L1).

- [x] **Cron scheduling — CHECKED against GCP 2026-09-23, and my prediction was WRONG.**
      I predicted `daily-scheduler` and `pending-sweeper` would have no Scheduler job, reasoning
      from the fact that five of six cron routes have no setup script in `scripts/`. **Both jobs
      exist, are ENABLED, and ran within the last day.** The setup scripts are an incomplete
      record of what was created, not a record of what exists — which is the same lesson as
      L41 pointing the other way: absence of a script proves nothing either.
      Eight jobs, all ENABLED, all with a recent `lastAttemptTime` (project
      `speedy-unison-453807-e9`):

      | Region | Job | Schedule |
      |---|---|---|
      | asia-south1 | `tokens-provision-pending` | `*/10 * * * *` |
      | asia-south1 | `tokens-charge-recurring` | `0 22 * * *` |
      | europe-west1 | `daily-scheduler` | `0 4 * * *` |
      | europe-west1 | `check-hosting-expiry` | `0 6 * * *` |
      | europe-west1 | `check-unprovisioned` | `5,35 * * * *` |
      | europe-west1 | `pending-sweeper` | `0 3 * * *` |
      | us-central1 | `daily-expiry-check` | `0 19 * * *` |
      | us-central1 | `hosting-expiry-check` | `30 19 * * *` |

      So the visibility added to `pending-sweeper` today IS reachable — it runs at 03:00 IST
      daily. Good.

- [x] **ZERO RETRIES — script written 2026-09-23, YOU RUN IT.** All eight jobs have
      `retryConfig.retryCount` blank, which Cloud Scheduler treats as no retry (AGENTS.md L1).
      `scripts/setup-cloud-scheduler-retries.sh` adds retries to **three** of them, and the
      omissions are the point (L3 — ask what each does when it HALF succeeds):
      · **Safe:** `pending-sweeper`, `check-unprovisioned` (0 writes, they report — worst case a
        duplicate admin digest), and `daily-scheduler` — safe *because of* its lock: rows are
        claimed for 10 minutes, so a retry inside that window skips them. Its retry window is
        capped at 5m, deliberately inside the lock.
      · **Excluded:** `tokens-charge-recurring` (charges cards — L3's canonical case; make it
        idempotent first), `tokens-provision-pending` (idempotency unverified),
        `check-hosting-expiry` (dispatches a Cloud Task per hosting with no lock of its own).
      The exclusions are asserted in `tests/unit/scripts/scheduler-retries.test.ts`, which also
      pins that `LOCK_DURATION_MS` is still 10 minutes — shortening it silently invalidates the
      cap. Red-checked both ways.
      **Run it from Cloud Shell** (gcloud is not installed on this machine):
      `bash scripts/setup-cloud-scheduler-retries.sh --dry-run` first, then without the flag.

- [x] **"Who is told when a cron fails?" — the transport WORKS; my first answer was wrong.**
      DMS `b1ef26c`, corrected in `e66432c`.
      I measured `systemlogs` at 34 rows, all source `"Client Boundary"`, newest 2026-08-13, and
      concluded no server-side error had ever reached it and that a silent branch in
      `remoteLog()` was why. **Both halves were wrong:**
      · `NEXTAUTH_URL` and `APP_URL` are BOTH set on the service to `https://app.anutech.in`, so
        that branch is never taken in production.
      · `middleware.ts` records this exact failure being found and FIXED on 2026-06-19 (the
        `SELF_AUTHENTICATING_ADMIN_API` allowlist — without it the server-to-self POST was 403'd
        before its own auth could run). **The oldest row in `systemlogs` is 2026-06-19.** The
        data corroborates that fix.
      So 34 browser-side rows and nothing since is consistent with **no server-side error having
      occurred** — production holds 2 orders and 0 domains, so traffic is near zero. I had one
      half of "absence of evidence" and shipped a conclusion without the other (L38, L39 — both
      of which I cited earlier the same day while doing it).
      **The change still stands**: the branch IS a silent no-op when those variables are
      missing, which is a real way to lose every server error in a future deployment. It now
      warns once. Only the justification was wrong, and it is rewritten in the file rather than
      softened.

- [x] **The "notice it a week later" half — BUILT 2026-09-23.** DMS `def2d93`.
      `models/CronRun.ts` (one row per invocation, 60-day TTL), `recordCronHeartbeat()` called
      by all four scheduled crons, and `lib/cron/staleness.ts` — the decision as a PURE
      function, because the last check of this shape cried wolf on its first contact with real
      data (L39).
      **Three conditions, not two:** no run in the window, a run was due, AND we were watching
      when it became due. Without the third, day one has no history for any cron and the first
      render reports the whole system broken — muting the alarm before it has ever been right.
      *"on day one, NOTHING is stale"* is the assertion the design turns on.
      **Two placement decisions are the real value:**
      · The heartbeat is stamped **after the auth gate**. Before it, any probe of the public URL
        would stamp a run and a deleted Scheduler job would read as alive — worse than no
        heartbeat, because it looks like evidence. A source scan asserts the ordering per route.
      · It surfaces on **admin integration-health**, not in a cron's own digest: a watchdog
        inside the thing it watches cannot report its own death. That page is pulled by a human,
        so it answers even when every job is dead. An unreadable heartbeat reports `unknown`,
        never an empty list that would render as "nothing wrong".
      It records THAT a cron ran, not whether it succeeded (`ranAt`, not `succeededAt` — L12);
      failures are already covered by the error path.
      `renewal-payment-dunning` and `da-health` are deliberately unwatched — no Scheduler job
      means a permanent daily red, and a standing red gets the section skimmed. A test pins that
      as a decision.
      **Not yet observed running.** Test-verified only; the first real rows appear after a
      deploy.

- [ ] **`renewal-payment-dunning` and `da-health` have NO Scheduler job at all.** Found
      2026-09-23 by comparing the route list against the live jobs — and the irony is that
      `renewal-payment-dunning` is the ONE route with a setup script
      (`setup-cloud-scheduler-billing.sh`), so the script was either never run or the job was
      deleted.
      Its own docstring states the cost: *"without this cron, an abandoned checkout is never
      followed up"* — a customer who opens the Razorpay renewal checkout and does not pay is
      never chased, across a 24h/72h/7d ladder.
      **Measured before claiming harm: production holds 2 orders total, 0 renewal orders in
      `pending`, and no order has ever carried a dunning stamp.** So this is an exposure, not
      an incident — nothing has been lost. It starts costing money the day renewals have
      volume.

- [ ] **DUPLICATE SCHEDULER JOBS — two endpoints are invoked twice a day, from two regions.**
      Confirmed by `httpTarget.uri` 2026-09-23. The us-central1 jobs are not new routes; they
      point at the SAME endpoints as the europe-west1 ones, under different names:

      | Endpoint | europe-west1 (Asia/Kolkata) | us-central1 (UTC) |
      |---|---|---|
      | `/api/cron/daily-scheduler` | `daily-scheduler` — 04:00 IST | `daily-expiry-check` — 19:00 UTC = 00:30 IST |
      | `/api/cron/check-hosting-expiry` | `check-hosting-expiry` — 06:00 IST | `hosting-expiry-check` — 19:30 UTC = 01:00 IST |

      **Measured as NOT harmful today, and the reason matters.** `process-service-expiry`
      advances `next_action_at` to the next threshold and sets `last_reminder_sent` before
      saving, so the day's second run finds nothing due and no customer gets two reminders. The
      cost is double load and a maintenance trap, not duplicate email.
      **The trap is the real problem:** two jobs, one undocumented, and nobody knows which is
      canonical. Change the schedule on one and the other still fires; delete what looks like
      the only job and the work silently continues from the other region. Neither appears in any
      setup script.
      **Removing one is an operator act on production infrastructure and is yours, not mine.**
      The europe-west1 pair is the one to keep — it matches the Cloud Run region and runs on
      Asia/Kolkata like every other DMS job.

- [x] **Timezone on `tokens-charge-recurring` — checked, and it is DELIBERATE.** I suspected a
      missing `--time-zone` flag putting a card-charging job at 03:30 IST by accident.
      `scripts/setup-cloud-scheduler-tokens.sh:105` sets `Etc/UTC` explicitly and says why:
      *"~03:30 IST means customers in India see their charge attempted in the dead of night,
      before their bank's batch-rejection cutoff if they have a low balance."* A real reason,
      thought through. AGENTS.md L36 — the code was documentation written by somebody with
      context I lacked.

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
- [x] **The local stack's safety is configuration, not isolation — CODE GATE ADDED 2026-09-23.**
      DMS `f5cb018`. `checkProviderSafety` extends `lib/ops/stack-inertness.ts` from a one-time
      pre-restore question into a runtime one, and the engine route refuses with 503 before
      dispatch.
      **The exposure was sharper than this note said, and it is not about live mode.** Engine
      commands contact providers in TEST mode too — every handler READS before deciding (the
      DirectAdmin account, the DNS zone, the registrar order and its expiry), which each header
      states as "no writes", not "offline". So on a dev box holding restored production data,
      one real credential in `.env.docker` was enough for a *dry run* to read a live customer's
      DNS. `LIVE_COMMANDS_ENABLED` never covered that: it gates live mode, and this is test mode
      working as designed.
      · production → allowed unconditionally (a guard that refuses the environment it was built
        for gets deleted — L103, and there is a test saying so)
      · dev + `.invalid` → allowed; it cannot resolve anyway, and keeping the local path usable
        is what stops someone reaching for a real credential to make the feature work
      · dev + real host → refused, naming the variable, what it reaches, and how to work locally
      An absent variable counts as LIVE, and an unset `NODE_ENV` as non-production — unknown is
      not safe.
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

- [x] **`appendUserDomain` writes nothing at all** — `lib/services/users.ts`,
      `models/User.ts` **[verified]** — **RESOLVED 2026-09-23, see §0.2.** Both halves of the
      entry below turned out to understate it: the write was not only dropped, its destination
      is read by nothing. The canonical source is the Domain collection, which
      `GET /api/user/domains` states in its own comment. The renewal now writes there; the
      function is deprecated, warns instead of pretending, and is kept only because domain
      TRANSFER still calls it and has no canonical write of its own.
      Original finding, left for the reasoning:
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

- [x] **`hosting.provision` — UNBLOCKED and built 24 Sep 2026** (decisions 23, 25; see §0A). The
      original entry, kept for the reasoning: **blocked, and not on effort.** DMS's `createUser` mints the
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
- [x] **Phase 8** — domain renew. **DONE 2026-09-23** — see §0.2. `expiryBefore` is required
      and sent verbatim, which turns RC's own `exp-date` into a working idempotency key;
      the same baseline is the reconciler, so it needed no human release. Performable,
      not live-eligible.
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
   still live and ungated TODAY, so reusing the paid path would mint a second tax invoice for
   one supply. Decision 3 (24 Sep) will switch that engine off; this invariant stays until then,
   and afterwards the reason becomes "ResellerOS is the only issuer" — the rule is the same.
9. The rate limiter is not a spend control (it returns `allowed: true` when Redis is absent).
10. A test-mode Razorpay payment can never reach a live command.

---

## D. Decisions needed — these block phases

- [x] **Zoho Books — REMOVED from DMS. USER DECISION, Pardeep, 24 Sep 2026:** *"Remove the Zoho
      completely. Mark it as user decision."* DMS's own GST engine is the only invoice issuer,
      with no fallback; a failed invoice is flagged on the order and retried, never re-issued
      elsewhere. Record and rules: DMS `CLAUDE.md` → "Zoho Books removed". Consequence for the
      seller-of-record question below: there is now exactly one invoice series on the DMS
      side (`TI/…`), which is simpler to reason about. **Overtaken the same day by §0A:**
      DMS is to issue no bills at all; ResellerOS issues every one and DMS keeps a copy. The
      Zoho removal itself stands. Zoho as a PRODUCT ResellerOS resells
      (Zoho Workplace licences) is unaffected — this is only about Zoho Books as DMS's
      accounting back end.

- [ ] **Who is the seller of record for an engine-sourced sale?** Blocks Phase 9. **Partly
      answered 24 Sep (§0A decisions 3 and 12):** ResellerOS issues every bill and takes the
      money. Still needs the CA to confirm for GST, and a credit-note route once DMS stops issuing.
- [x] **How does a ResellerOS-only buyer get a ResellerClub customer?** **Answered 24 Sep
      (decisions 22-23):** the checkout collects the registrant's address, and the engine's
      `domain.register` finds or creates the DMS account and the RC customer + contact by email
      (`getOrCreateCustomerAndContact`), then registers under them.
- [ ] **Which side owns DirectAdmin?** Keeping both writers means two username derivations and
      two definitions of `vendor_ref`. Did NOT block Phase 7 in the end — `hosting.change_plan`
      shipped by working with the existing `(userId, domainName)` uniqueness rather than
      altering it.
- [x] **Spend control — answered for `domain.register` (decision 24):** live payment, paid ≥
      cost, daily count + ₹ cap (engine-register-policy.ts). `domain.renew` still has none and
      stays live-ineligible; the same policy shape could be reused for it.
- [ ] **(original entry) What shape should the engine's spend control take?** Found 2026-09-23 while deciding
      whether `domain.renew` could be armed. Nothing anywhere caps how many money-spending
      commands a caller can trigger — irrelevant while every command was free or reversible,
      and now the reason `domain.renew` stays live-ineligible. It will gate Phase 9 the same
      way. Per tenant, per day, a rupee total, or a human release per row: the answer decides
      how much of Phase 9 is design and how much is plumbing.
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
- [x] **Does the local Supabase match the committed migrations? ANSWERED 2026-09-23** — yes in
      the direction that matters, with one thing worth knowing.
      · **Nothing is missing.** Every table and function that `baseline.sql` and the 83
        committed migrations create exists in the local database. Checked by extracting the
        `create table` / `create function` names from all 84 files and querying `pg_tables` /
        `pg_proc`, not by reading a ledger — because there IS no ledger: local has no
        `supabase_migrations.schema_migrations` table at all. That is consistent with §4a (a
        fresh database comes from `baseline.sql`, not from running the migrations).
      · **Local carries 10 tables no committed SQL creates:** `domains`, `dns_records`,
        `domain_watches`, `domain_renewals`, `domain_renewal_notices`, `hosting_accounts`,
        `hosting_plan_changes`, `egress_ip_checks`, `recurring_charge_attempts`,
        `reseller_wallet_entries`. Every one is domain/hosting — i.e. the territory DMS owns
        since the federation decision. Almost certainly retired tables that predate the current
        `baseline.sql`, still sitting in a local database nobody has rebuilt. **No ResellerOS
        code references them** (checked; the only `dns_records` hits are an AI support-ticket
        CATEGORY string, unrelated).
      · **Consequence, and it is small but real:** local is not what a fresh build from
        `baseline.sql` would produce. Rebuilding local would drop those 10, which is fine —
        but it means "it works locally" is a statement about a database with history, not about
        the committed schema. For anything schema-sensitive, rebuild first.
      · The object counts in §4a (87 tables / 133 functions / …) match `baseline.sql` exactly —
        87 `CREATE TABLE` statements — so those numbers describe the BASELINE, not today's
        production, which has had 83 migrations applied since. Worth knowing before quoting
        them as production's shape.

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
- [x] **Orphaned portal auth users — MEASURED, then LEFT IN PLACE by decision (Pardeep,
      2026-09-23).** Not an oversight: a deliberate accepted state.
      **No data leak, verified in the browser rather than reasoned.** A throwaway auth user with
      no `public.users` row — an orphan's exact shape — was signed in and walked `/dashboard`,
      `/leads`, `/payments`, `/customers`, `/settings`. Every page rendered and **every one was
      empty**: ₹0 closed, ₹0 pipeline, "All Invoices Settled", sidebar reading "No workspace".
      RLS holds, because `current_tenant_id()` is null without a users row. The throwaway user
      was deleted afterwards.
      **What is accepted, in plain terms:** `portal-test@anutech.invalid` and
      `rajesh@acmecorp.com` remain in `auth.users` unbanned (measured on LOCAL; production not
      checked), so a retired portal credential can still sign in, reach the staff SHELL, and is
      offered the onboarding flow — "Add your organisation", "Add your GSTIN" — i.e. it can
      **self-provision a workspace**. That is the risk being carried, and it is carried
      knowingly.
      **The mechanism, for whoever revisits this:** middleware's role guard reads
      `if (isAuthed && isProtected && role && role !== "owner" …)`, so a null `role` **skips**
      the guard rather than failing it. Deliberate for `/welcome` (the fork for someone with no
      workspace yet) and documented there, but the skip applies to every protected route and
      nothing routes a null-role session TO `/welcome`.
      **If it is ever picked up**, two cheap fixes: ban or delete the orphaned users (check
      PRODUCTION's list first — this was local), or route null-role sessions to `/welcome` only
      — carefully, because a brand-new signup is also null-role for a moment and must not be
      bounced.


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
- [x] **SUPERSEDED 24 Sep 2026 by §0A decision 1** — ResellerOS's cart and billing are now
      primary for first purchases; DMS's funnel stays for in-panel purchases. The entry below
      is kept as the record of what was true before.
      **The purchase funnel is deliberately NOT taken over.** `/hosting`, `/domains/*`,
      `/cart` and `/checkout` are the **only working way to buy hosting or a domain**;
      ResellerOS has marketing pages for both but no management UI (see below). Tests in
      both `lib/reseller-os.test.ts` and `middleware.test.ts` pin that these are untouched,
      so widening the map fails rather than quietly removing the way to sell. Decide this
      together with the port-vs-rewrite question below, not before it.
- [x] **DMS's public nav — DONE 2026-09-23 (DMS `b245baf`), and BOTH reasons this entry gave
      for leaving it alone were false.** It said the Home link "costs a hop rather than being
      wrong", left alone because rewiring "means swapping `<Link>` for `<a>`".
      · **A `<Link>` with an absolute href is fine** — browser-verified: it renders a plain
        anchor, is not prefetched, and navigates correctly. No swap was needed.
      · **`isActive('/')` was never the obstacle.** It is `pathname === '/'`, and with a front
        door DMS never *serves* `/`, so that branch cannot fire there anyway. Left keyed on
        `'/'` so standalone DMS is untouched.
      · **And two nav items were BROKEN, not slow.** `/#domain-search` and `/#pricing` redirect
        to ResellerOS's home, which carries **neither anchor** — the only match in its HTML is
        the image `/domain-search.jpg`. So the two items whose job is to start a purchase
        landed at the top of a page with no search and no prices. `homeAnchorHref()` re-points
        them to `/domains-home` and `/hosting#pricing`, both checked to serve 200, to be
        outside the redirect map, and to carry the content named.
      · Kept **inside DMS** deliberately: DMS is still the only side with a checkout, so
        pointing these at the front door would send a buyer to an app that cannot take money.
      · Nine `href="/"` links across eight more files got `homeUrl()` for the same reason.
      **Browser-verified across seven public pages: 3 → 0 CSP violations, 0 cross-origin
      requests.** The earlier "0 console errors" was measured on `/login` alone and was never a
      statement about the app — `/cart` was logging three the whole time.

- [ ] **`/hosting` and `/` are set to DRAFT in DMS — worth your decision, not a bug.**
      Found while checking where to point "Pricing". `settings.page_visibility` reads
      `{ hosting: 'draft', home: 'draft' }`, updated **2026-07-21** — two months before any of
      the federation work, so it is your content decision and nothing here changed it. The
      effect today: DMS's `/hosting` renders a server `redirect('/')`, which arrives inside a
      200 and is followed client-side, so a visitor ends up on ResellerOS's homepage. That
      makes "Pricing" correct in code and inert in practice until `/hosting` is published in
      Admin → Pages. Measured on the LOCAL database only — production was not read.
- [x] **The `<AdminLayoutSkeleton>` half is DONE 2026-09-23** (DMS `b953b62`) — and **this entry
      was wrong to treat the two wrappers as the same job.**
      · **The skeleton's chrome could never render.** Its own comment said it was kept
        "because this component is also used outside the /admin subtree". Measured: all 19
        importers are admin pages, every one under the shell `app/admin/layout.tsx` mounts, so
        the guard always fired. The unreachable branch was `bg-blue-900` — the pre-restyle
        sidebar this whole fix exists to stop — so the day it HAD rendered it would have been
        wrong. Component and all 19 wrappers deleted.
      · **A test was what kept it alive.** Two rendered it with no `AdminShellContext`
        provider and asserted the dark chrome appeared — green, proving a configuration no
        caller can produce (AGENTS.md L111). Replaced, as L111 says, by the invariant that made
        them pointless: a scan that no page under `app/admin` renders a shell skeleton, plus an
        assertion that the provider is given `value={true}` (`false` compiles, passes every
        component test, and puts a second sidebar on every admin page). Red-checked.
      · **BROWSER-VERIFIED against the original bug, not a proxy.** Five client-side
        navigations with the sidebar node tagged first: it survived every one, `<nav>` stayed
        at exactly 1, and a per-frame watcher counted **0 frames showing `bg-blue-900`** and 0
        with no nav. 0 console errors.

- [x] **A dead logout that never cleared the session — FIXED 2026-09-23** (DMS `2570425`).
      Found while checking whether the self-wrapping `<AdminLayout>` pages were worth
      unwinding. Five of them passed `onLogout={() => { window.location.href = "/login" }}`,
      which navigates and nothing else; `performLogout` — used by the other 19 and by the
      shell — calls `signOut({redirect:false})` and clears local and session storage. Had it
      run, the operator would have landed on /login **still authenticated**.
      It never ran: inside the shell `AdminLayout` returns only its children, so a page's own
      `onLogout` is dead and the shell passes the real one. **Wrong AND unreachable is what let
      it survive** — the same shape as the dark-blue skeleton chrome. All five now pass
      `performLogout`, guarded by a scan (dead props cannot be covered by a component test,
      because nothing renders them). Red-checked.

- [ ] **The 25 pages that wrap themselves in `<AdminLayout>` — leave them, and do it per page.**
      **The count is 25.** This entry said 25 originally, I "re-counted" it to 20 and then 21,
      and the original was right: my pattern required `<AdminLayout` followed by a space or `>`
      and missed the five that open the tag across lines. A correction that makes a number worse
      is still a stale number (§12).
      **Measured reasons not to do it as a dedicated pass**, replacing the earlier "no per-page
      tests" hand-wave:
      · It changes no behaviour and removes **no dead code**. Unlike the skeleton's chrome,
        `AdminLayout`'s chrome is LIVE — `app/admin/layout.tsx` renders it outside the provider.
      · The earlier claim that unwinding "can orphan variables" is wrong about `user`: every
        one of the 25 uses it 6-62 times beyond the wrapper. It is the logout handler that would
        orphan, in 17 of them — and that is compile-visible, so it was never the real risk.
      · **The real risk is mechanical.** Two pages put arrow functions inside the tag and five
        open it across multiple lines, so a naive match is unsafe; and **14 of the 25 contain
        multi-line template literals (52 in all)**, so the body cannot be safely re-indented
        afterwards — de-indenting would alter string CONTENTS (L49).
      Best done one page at a time, when that page is being edited anyway. The one thing the
      redundancy actually cost has now been paid: see the dead-logout entry above.

- [ ] **The DMS palette conversion — and the headline number counts DEAD CODE (2026-09-23).**
      The panel-scoped figures stand (`app/admin` 563, `app/dashboard` 200), but two things
      found while starting the work change how to approach it:
      · **114 legacy classes are in components nothing renders.** `DomainBookingProgress` (36),
        `AdminStatsCard` (33), `AdminQuickActions` (29) and `NameServerManagement` (16) are
        imported only by `components/index.ts` — **a barrel that nothing imports**. Git says
        they were never wired rather than deliberately unmounted, so they are dead by neglect.
        Left in place: deleting unused components is the owner's call, not a side effect of a
        palette pass. But do not count them as work.
      · **The obvious proxy for "is this rendered" is wrong in BOTH directions.** "Does any file
        under `app/` mention it" marked `FooterClassic`, `CustomToast` and `LoadingComponents`
        dead when they are reached through `Footer.tsx`, `lib/toast.tsx` and `UserLayout.tsx`.
        Only enumerating every importer settles it.
      · **`components/DomainRenewalModal.tsx` is DONE** (DMS `31bb336`) — the file this entry
        named as proof the panels are not uniformly converted. 47 → 0, using the mapping already
        applied in `ActionMenu.tsx`/`Modal.tsx` rather than a new one. Typecheck and the full
        suite green; **not browser-verified**, because reaching that modal needs a customer
        session, a domain and a click.
      · **`HostingRenewalModal` (49) and `DomainSetup` (36) are DONE** (DMS `db6be24`). All
        three panel modals now agree on `bg-primary-600/700` for the primary action.
      · **RE-MEASURED 2026-09-23, and every earlier figure in this entry was far too small.**
        `scripts/palette-audit.mjs` in DMS (`a334593`) replaces hand-grepping — **do not quote
        the numbers below, run it.** They are recorded only so a reader can tell whether the
        picture has moved.

        | | classes | files |
        |---|---|---|
        | total | 3,746 | 161 |
        | reachable by import | 3,502 | 135 |
        | **served by DMS today** | **3,062** | **124** |
        | only via a route that 307s to ResellerOS | 440 | 11 |
        | unreachable (dead) | 244 | 26 |

        Against the old headline of **1,272** the real served figure is **3,066** — about 2.4x.
        This entry said the count was wrong in both directions; it is, and the understatement
        dominates so completely that "inflated by dead code" was the less useful half.
      · **Three corrections are baked into the script rather than left as advice.**
        **Legacy = a stock Tailwind family with a NUMERIC suffix**, which fixes the token
        boundary for free (`bg-emerald-50` counts, `bg-emerald-soft` does not, `primary-600`
        is a token so that family is not listed). **Reachability comes from the import graph**,
        walking `lib/`, `hooks/`, `store/` and `middleware/` as well — the first version omitted
        them and called `CustomToast` dead, which is the exact blind spot recorded above
        reappearing in a new form. And **reachable-by-import is not SERVED**: six DMS routes
        redirect to ResellerOS, so `HostingLanding.tsx` — the biggest file in the repo at 158 —
        is only reached through `/`, and proposing it as work would spend a day on a screen no
        federated visitor can open. Listed separately, not dropped, since standalone DMS serves
        all six.
      · **The real worklist is `components/` (1,260) and `app/admin` (1,024)**, not the
        marketing pages. Biggest served files: `app/admin/dashboard` 118, `app/payment-success`
        109, `app/dashboard/dns-management` 108, `app/admin/pending-domains` 107,
        `app/checkout/guest` 103.
      · **This is a much larger job than the entry implied, and the shape of it is your call.**
        At roughly 25-50 classes per component with a browser check each, 3,066 is weeks rather
        than an afternoon. Worth deciding whether it happens panel-by-panel as screens get
        touched anyway, or as a dedicated pass — rather than continuing to shave the top of the
        list one component at a time.
      · One thing deliberately not converted, with the reason recorded in the file: a decorative
        `from-indigo-50 to-purple-50` gradient. There is no gradient token pair and `purple` is
        off-palette entirely, so flattening it is a design decision rather than a substitution.
      · **`HostingUpgradeModal`, `LoginForm` and `DomainCrossSell` are DONE** (DMS `385c482`),
        all three to 0. `LoginForm` is **browser-verified** — it is the one screen of the three
        that renders with no session, so it was screenshotted at `localhost:4310/login` rather
        than reasoned about. The other two need a customer session and a click, so they are
        reasoned-only. `DomainCrossSell`'s green "buy" CTA was deliberately **kept green**
        (`bg-emerald`/`bg-emerald-ink`): green is semantic there — the affirmative action beside
        a dismiss — and repainting it brand-blue would make it read as one more nav control.
      · **Browser-verifying one of them found a defect no test could see** — see the CSP entry
        below. That is the argument for doing this work in front of a browser rather than a diff:
        jsdom does no layout and a class rename is invisible to the suite either way (L16), so
        the screenshot is the only thing the conversion is actually checked against, and it
        catches things that have nothing to do with colour.
- [x] **DMS asked its own server for pages ResellerOS now owns — FIXED 2026-09-23** (DMS
      `d304b18`). Seen as one CSP violation per page load while screenshotting `/login`:
      `Connecting to 'https://localhost:4320/privacy' violates … "connect-src 'self' …"`.
      Seventeen links across six files carried a literal href to a path ResellerOS owns
      (`/privacy`, `/terms-and-conditions`, `/cancellation-refund`, `/contact`, `/about`). DMS
      307s each of those to the ResellerOS origin; Next prefetches a `<Link>`; a prefetch is an
      RSC *fetch*; a fetch redirecting cross-origin is policed by `connect-src`. So the prefetch
      was refused on every public page view.
      · **Measured before deciding, and it changes the framing: the click always worked.** A
        navigation is not policed by `connect-src` — error count 1 before the click and 1 after,
        landing on the right page. Never a dead link; console noise plus a wasted redirect hop.
        Worth removing *because* it is harmless — a violation nobody needs to act on is what
        teaches the next reader to skim the console (L6).
      · Fixed with `publicPageHref()`, four lines over the already-tested `resellerOsOwnedUrl()`,
        so a link carries the SAME url the middleware would have redirected it to. Standalone DMS
        is untouched. **Widening `connect-src` was refused** — that buys a quiet console by
        letting every DMS page fetch another origin, a real permission traded for a cosmetic one.
        So was `prefetch={false}`: one decision copied twelve times (L98), redirect still there.
      · Guarded by a **source scan**, not only a unit test, for the L98 reason — the helper's own
        test stays green while somebody adds an eighteenth footer link with a literal path.
        Red-checked by restoring one literal; it fails naming `components/FooterModern.tsx`. It
        also asserts the helper is used in ≥6 files, since "no offenders" is equally true of
        having deleted every link.
      · **Browser-verified** against a rebuilt container: href absolute, **0 console errors**
        before and after the click (was 1), click still lands on ResellerOS's Privacy Policy.
      **Next step is a decision, not a component.** The worklist is now measured rather than
      guessed, and it is large enough that picking the next file off the top is the wrong
      move on its own — see the last bullet above.
- [ ] **Commit-email linkage unverified.** Commits use `pawan@exceltechnologies.in`; they will
      only link to the GitHub account if that address is verified under Settings → Emails.
- [ ] **No PR opened from here, and that is now the standing rule** — do not open one unless
      explicitly asked (AGENTS.md §10 rule 4, 23 Sep). `gh` is not installed on this machine
      (re-checked 23 Sep), so whether one exists was NOT verified. Links:
      `github.com/Abhicode0to1/new-reselleros/pull/new/pawan-api-system` and
      `github.com/exceltechnologies-india/domain-management-system/pull/new/pawan-api-system`.
      Worth doing soon: AGENTS.md §9 notes CI runs on PRs and pushes to `main` but NOT on
      feature branches, so the local gate is currently the only gate on both.
- [x] **Abhishek's merged screens — BROWSER-VERIFIED 2026-09-23.** Signed in as the local dev
      user and drove `/subscriptions` with Playwright against the running app, not the test
      suite. All four merged controls work:
      · **sorting** — clicking `CUSTOMER · DOMAIN` reorders the rows
      · **bulk actions** — the bar tracks the selection exactly (1 ticked → "1 selected",
        2 → "2 selected") and offers Export / Send renewal quotes / Delete / Clear
      · **drawer** — opens for the row clicked, showing that subscription's plan, seats, MRR
        and its actions
      · **licence leakage on rows** — "— / 25 NOT CHECKED" per row plus the summary card
      **Zero console errors, no error boundary.**
      **The first run proved nothing and I nearly reported it as a pass.** Local held ONE
      subscription, so sorting was "not attempted" and multi-select was impossible — the two
      things most worth checking were exactly the two the data could not exercise. Seeded four
      rows, re-ran, and removed them afterwards (local is back to 1). **If you repeat this,
      seed first**; a green run against one row is a statement about rendering, nothing more.
      Worth noting from the screen: the margin card says the margin is *"unknown, not healthy"*
      rather than inventing a figure, and the drawer says *"no start or renewal date, so there
      is no term to lay a schedule against"*. That is §2 showing up in the UI.
