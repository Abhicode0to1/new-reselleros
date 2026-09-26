# Cross-team requests — from Pardeep (Accounting & Finance)

When Accounting & Finance work needs a change in code another person owns, we do **not**
edit their code. We write the request here, and Pardeep passes it to the owner.

| Area | Owner | Branch |
|---|---|---|
| Billing & Subscriptions (Customers, Parent Accounts, Quotes, Subscriptions, Renewals, Invoices, Payments Received, Project Sales) | Abhishek | `abhishek-pre-merge` |
| Customer UI, customer panel, checkout process | Pawan | `pawan-api-system` |
| Accounting & Finance (`/accounting/*`, `/compliance/*`, Reports Hub) | Pardeep | `pardeep-sir` |

Status values: **Open** → **Sent** (Pardeep told the owner) → **Done** (merged into our branch).

---

## Requests

## Abhishek's reply — 2026-09-26

**All eight are done.** Every one sat inside Billing & Subscriptions, so none needed
anyone else's branch. Each entry below carries what was changed, what was tested, and
where I deliberately did something other than what was asked.

| Req | What landed |
|---|---|
| R-001 | `requireTenantId()` — no seed-tenant fallback, no fabricated customer on a failed insert |
| R-002 | Project sale picks a real customer; inter-state derived from the two states |
| R-003 | Milestone invoices dated when issued; `paid_date` keeps the real receipt date |
| R-004 | New `update_project_details` RPC + "Edit project" screen |
| R-005 | Project clients no longer read as dead accounts; "Project value" on the strip |
| R-006 | Project quotations appear under Customer 360 → Quotes |
| R-007 | Seven foreign keys → RESTRICT; `delete_customer` counts notes and TDS |
| R-008 | "From lead: …" on the project page; your Won trigger left alone |

**Four things worth your attention, rather than buried in the entries:**

1. **R-006 item 2 was already built.** `/quotes` has had a Subscription | Project toggle
   since 4 Aug 2026 (`e04a81af`). The request assumed it did not. Nothing was needed.
2. **R-007's invoice half was narrower than it looked.** The invoice-immutability trigger
   already refused to null out `customer_id` on an *issued* invoice — found by red-checking
   the new test. The orphaning measured on 25 Sep was on **quotes**, which had no guard.
   The migration still covers all seven tables; drafts were genuinely exposed.
3. **R-004: I froze the customer once a tax invoice exists**, which is narrower than the
   request. Reasoning is in that entry. Push back if you disagree.
4. **R-001's twin is still open and is NOT mine.** `useCreateLead` has the identical
   seed-tenant fallback at `lib/queries/leads.ts:246`. Leads are your CRM, so I left it and
   allow-listed it in the scan with the reason written next to it. `requireTenantId` is
   exported and the fix is two lines.

**Verification, honestly split.** R-001, R-003, R-004 and R-007 are proved against the
database (SQL tests, each red-checked by reintroducing the defect). R-002, R-005, R-006 and
R-008 are test-verified only — this local database was rebuilt from the baseline today and
holds no customers or projects, so there was nothing to look at in a browser. They are worth
one pass on your machine, where Excel Technologies and its ERP project exist.

---

### R-001 · `useCreateCustomer` can put a customer in the wrong company, or report a fake one
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** Banking → Reconcile → "Kisi sale / customer ka paisa?" now opens your
  `AddCustomerForm` for "＋ Naya customer" (used as-is, not changed). The customer it returns is then
  invoiced against a real bank receipt, so the two problems below can reach the books.
- **What to change** — `production/src/lib/queries/customers.ts`, `useCreateCustomer`:
  1. **Line ~69 — hardcoded tenant.** `let tenantId = "11111111-1111-1111-1111-111111111111"` is used
     whenever the user/tenant lookup returns nothing. That is the local demo tenant; in production a
     failed lookup would insert the customer into the wrong company (AGENTS.md: never hardcode a
     tenant). It should throw instead ("Not signed in / not linked to a company").
  2. **Lines ~134–162 — fake customer on insert failure.** When the insert errors, it builds a
     `CUST-<timestamp>` customer, puts it in the list cache and returns it as success
     ("Dev mode customer insert warning"). The screen then shows a customer that does not exist, and
     anything done with its id (invoice, reconcile) fails later with a confusing error (AGENTS.md: never
     turn a failure into a plausible value). It should `throw error` so the form shows the real reason.
- **Done when:** a failed insert shows an error and adds nothing to the list; no code path inserts
  with tenant `11111111-…`.

- **Done by Abhishek (2026-09-26):**
  - New `production/src/lib/queries/require-tenant.ts` — `requireTenantId()` resolves the tenant
    from auth + `public.users` and **throws** when it cannot. No default, and a failed READ is
    treated as "unknown company", not as "keep the default" (that `if (me?.tenant_id)` was the bug).
    Both messages say what to do next (§24).
  - `useCreateCustomer` calls it; the `11111111-…` literal is gone from the write path.
  - The insert-failure branch is deleted. It used to build `CUST-<Date.now()>`, push it into the
    list cache and return it as success. Now `if (error) throw new Error(error.message)`, so the
    form shows the database's own reason and nothing is added to the list.
  - Tests: `require-tenant.test.ts` (6) — red-checked by putting the seed-tenant fallback back,
    4 of 6 went red. `no-seed-tenant.test.ts` (5) scans all of `src/` so a new default cannot
    appear anywhere; it caught a real file on its first run.
  - **Still open, and NOT ours:** `useCreateLead` has the identical fallback at
    `lib/queries/leads.ts:246`. Leads are Pardeep's CRM, so it was left alone and allow-listed in
    the scan with that reason written next to it. Pardeep — same two-line fix, `requireTenantId`
    is exported and ready.

### R-002 · "New project sale" should pick a real customer, not a typed name
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** Banking → Reconcile → "Project payment" sends a bank receipt to
  `/projects?amount=…&reconcile=…` to be booked as a project sale. Today the project is saved with
  `customerId: null` and only a typed name, so:
  - the sale never appears in that customer's **Ledger (Khata)** or **Customer Aging**;
  - a typo ("Excel Tech" vs "Excel Technologies") silently becomes a different party;
  - IGST vs CGST+SGST comes from a manual checkbox, not the customer's state — the same
    "place of supply assumed" problem the GST health card on Accounting Overview flags.
- **What to change** — `production/src/components/features/projects/create-project-dialog.tsx`:
  1. Replace the free-text Customer `Input` (line ~117) with the existing
     `components/features/customers/customer-combobox.tsx`, plus a "＋ New customer" that opens the
     existing `AddCustomerForm` (same pattern as the quote builder and the reconcile dialog).
  2. Send the chosen `customerId` (line ~91) instead of `null`, with `customerName` from the record.
  3. Default the inter-state checkbox from the customer's `state_code` vs the seller's state
     (still editable).
- **Done when:** a project sale created from the dialog has `customer_id` set and shows under that
  customer's Ledger; inter-state is pre-set from the customer.

- **Done by Abhishek (2026-09-26):** all three points, in `create-project-dialog.tsx`.
  1. The free-text `Input` is gone. It is `CustomerCombobox` — the same searchable picker the
     quote builder uses — with **＋ New customer** opening `AddCustomerForm`, so a customer
     created here still gets its mandatory contact person and comes back **selected**.
  2. `customerId: null` is gone; the chosen id is sent and `customerName` is read off the
     record, so a typo cannot invent a second party. The form cannot be submitted with no
     customer chosen.
  3. Inter-state is pre-set from the customer's state against the tenant's, through
     `isInterStateSupply` — and **both GSTINs are passed**, because 36 of 41 customers holding
     a GSTIN have no `state_code` and the first two characters of a GSTIN are the state.
     Without that the pre-set would have quietly taxed most customers intra-state, which is
     the same defect in a new place.
  - Still editable, and an explicit tick is never overwritten afterwards — the effect would
    otherwise fight the operator on every re-render.
  - The dialog now SAYS where the tick came from ("Set from <customer>'s state (Karnataka)
    against yours"), and when the tenant has no state configured it says so and points at
    Settings → GST profile rather than silently defaulting to intra-state.
  - Tests: `create-project-dialog.wiring.test.ts` (10), red-checked by putting
    `customerId: null` back.
  - **Verification:** test-verified, not browser-verified — this local DB was rebuilt today
    and has no customers to pick from.

### R-003 · Milestone invoices are back-dated, so invoice numbers and dates go out of order
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** GST rule 46 wants tax invoices numbered consecutively in the
  order they are issued; GSTR-1 lists them by date. Today a milestone invoice raised later can
  carry an earlier date than one raised before it. Seen locally on 25 Sep 2026, both raised the
  same day from Banking → Reconcile → Project payment:
  - `INV-1111-2026-27-0002` dated **7 Aug 2026**
  - `INV-1111-2026-27-0003` dated **8 Jul 2026** — higher number, earlier date.
  An auditor reads that as a back-dated or inserted invoice.
- **What to change** — DB function `raise_project_milestone_invoice` (project module):
  it sets `v_inv_date := <first payment date>` when the milestone is fully paid, else
  `current_date`. The number comes from `next_document_number` at the moment it runs, so any
  back-date breaks the order. Options (your call):
  1. Always date the invoice `current_date` (the day it is actually issued). The receipt keeps its
     own date; an advance received earlier is covered by the receipt, not by back-dating the invoice.
  2. Or, if back-dating must stay, refuse a date earlier than the latest invoice already issued
     in that series.
- **Done when:** raising milestone invoices in any order never gives a higher number an earlier
  date than a lower number in the same series.

- **Done by Abhishek (2026-09-26):** option 1 — the invoice is dated the day it is issued.
  - Migration `20260926140000_milestone_invoice_dated_when_issued.sql` replaces
    `raise_project_milestone_invoice`. `v_inv_date := current_date`, always. Everything else in
    the function is byte-identical.
  - **`paid_date` keeps the real receipt date.** Forcing both columns to today would have fixed
    the series and broken the ledger — it would say the money arrived when the paperwork did.
    An advance that landed before its invoice is covered by the receipt voucher, as you noted.
  - `due_date` still cannot precede the invoice date (the `greatest(...)` is unchanged).
  - Test `supabase/tests/milestone_invoice_dated_when_issued.test.sql` raises two milestones
    whose payments arrived in the opposite order. Red-checked by putting the old expression
    back: it reproduced your exact symptom — `…0002` dated 8 Jul under `…0001` dated 7 Aug.
  - Option 2 was not taken: it keeps back-dating and adds a guard that fires mid-billing with
    no way forward, which is the dead end §24 forbids.

### R-004 · Edit an active project — contract value, title, customer
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** once a project is Active (quote accepted, or created from a bank
  receipt in Banking → Reconcile → Project payment) nothing on `/projects/[id]` can change its
  contract value, title or customer — only dates, costs and labour. When the deal changes (scope
  added, discount, wrong value typed while booking the receipt) the only way today is a DB edit.
  The project's value drives the Project margin card and the P&L's project revenue, so a wrong
  value stays wrong in the books.
- **What to change** — project detail page + a new RPC (project module):
  1. An **"Edit project"** button next to "Edit dates": title, description, customer (the existing
     `customer-combobox` + `AddCustomerForm`, see R-002), total contract value (GST-inclusive),
     GST rate, inter-state.
  2. The RPC recomputes `taxable_amount` / `gst_amount` / `total_amount` and re-plans only the
     milestones **not yet invoiced or paid** (same rule as `update_project_future_milestones`:
     locked milestones stay, the rest must add up to the new total minus the locked amount).
  3. Refuse a new total below what is already invoiced or paid. Invoices already raised are
     never touched — a change after invoicing is a credit / debit note, not an edit.
- **Done when:** an active project's value, title and customer can be changed from its page;
  invoiced / paid milestones and their invoices are unchanged; a value below invoiced is refused.

- **Done by Abhishek (2026-09-26):**
  1. **"Edit project"** sits next to the status badge on `/projects/[id]`, opening
     `edit-project-dialog.tsx`: title, description, customer (the same `CustomerCombobox`
     + `AddCustomerForm` as R-002), GST-inclusive contract value, GST rate, inter-state, and
     the remaining milestones.
  2. **New RPC `update_project_details`** (migration `20260926150000`). It recomputes
     `taxable_amount` / `gst_amount` / `total_amount` and re-plans only the milestones that
     are NOT invoiced or paid — using the same definition of "locked" as
     `update_project_future_milestones`, deliberately, so the two cannot disagree. Every
     argument is optional, so a title-only edit does not restate the money and does not
     touch the schedule.
  3. **A total below what is already invoiced or paid is refused**, and the dialog says so
     before the round trip rather than letting the database reject a schedule already typed.
     Invoices already raised are never touched.
  - **One rule I added that you did not ask for, and one narrowing you should look at:**
    - Added: changing the value *without* sending a schedule is refused. Otherwise the
      project keeps instalments that no longer add up to its total, and no screen says why.
    - Narrowed: **the customer is frozen once a tax invoice exists.** R-004 lists the
      customer as editable; I have allowed it only while nothing is invoiced. That invoice
      was issued to a named party, and re-pointing the project would leave the two
      disagreeing with no record of which is right — the same principle as R-007. It
      matches the `partialLock` the project quote dialog already applies. **If you want it
      editable anyway, say so and I will open it up.**
  - Tests: `supabase/tests/update_project_details.test.sql` — the control first (an ordinary
    edit works: 354000 incl. → 300000 + 54000, three milestones), then the four refusals.
    Red-checked by disabling the below-committed guard, which produced "must add up to
    Rs -39000" — the nonsense the guard exists to prevent. Plus
    `edit-project-dialog.wiring.test.ts` (11), also red-checked.
  - **Verification:** test-verified, not browser-verified — this local DB was rebuilt today
    and has no projects to open.

### R-005 · Customers list ignores project sales — a software client shows "No subscription, ₹0"
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** Excel Technologies has an active project (Complete ERP, ₹10,80,000,
  `project_sales.customer_id` correctly set) yet `/customers` shows it as **"No subscription"**, Monthly
  ₹0, Yearly revenue ₹0, and it falls under the "No subscription" filter. The list reads only
  subscriptions, so a customer who buys custom software looks like a dead account. (The Customer 360
  page already shows the project — the data is there, only the list misses it.)
- **What to change** — `production/src/app/(app)/customers/page.tsx`:
  1. **Status (~line 109):** a customer with an active / quoted project and no subscription shows
     e.g. "Project client" (or "Project · Complete ERP"), not "No subscription".
  2. **Filters (~line 61):** add "With projects"; "No subscription" should not read as inactive for
     them (or exclude customers with active projects).
  3. **Portfolio strip (~line 429):** add "Project value" (active projects' contract total) next to
     Monthly / Yearly revenue, which are recurring-only and should stay so.
  4. Optional: a "Projects" column or badge with the count / contract value.
  `useCustomerProjects` / `useProjectReceivablesByCustomer` in `lib/queries/projects.ts` already
  return what is needed (the page already uses the latter for "To collect").
- **Done when:** Excel Technologies shows as a project client with its project value, and appears
  under a "With projects" filter.

- **Done by Abhishek (2026-09-26):**
  - New `lib/customers/portfolio-status.ts` holds the rule, and the row pill, the phone card
    and the segment filters all call it — the pill and the filter counts could drift before,
    because each had its own idea of what a customer was.
  - **Status:** a customer with a won project and no subscription reads **"Project client"**.
  - **One deliberate difference from the request.** You wrote "active / quoted". I split them:
    a quotation is a document, not a relationship, so a quoted-only customer reads
    **"Project quoted"** instead. Calling somebody a client on the strength of a quote they
    have not accepted is the same overstatement as counting a quote as revenue — and
    "Project quoted" is the more useful thing to see anyway, since it is a deal to chase.
    Say the word and I will collapse them.
  - **Filters:** added **"With projects"**. "No subscription" is renamed **"No business"** and
    now excludes anyone with won project work — it was being read as "dead accounts", which
    is exactly how Excel Technologies ended up in it. A customer with only a quotation still
    appears there, because they genuinely have no business yet.
  - **Portfolio strip:** added **"Project value"** (won projects' contract total), clickable
    through to the new segment. Deliberately NOT added to Monthly or Yearly revenue — those
    are recurring figures, and folding a ₹10.8L one-off build into "Yearly revenue" would make
    next year's forecast wrong by the whole amount. There is a test asserting it stays out.
  - Cancelled projects count for nothing; a negative contract value is ignored rather than
    subtracted, so bad data cannot hide behind a smaller plausible total.
  - Tests: `portfolio-status.test.ts` — 23, including a scan that both the table and the
    phone card call the shared rule and that no local copy survives.
  - **Verification:** test-verified, not browser-verified. This local database was rebuilt
    today and has no projects in it, so there was nothing to look at. Worth one look on your
    machine, where Excel Technologies exists.

### R-006 · Project quotations don't appear under "Quotes"
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** a project's quotation lives on `project_sales` itself (status
  `quoted` → `active` on acceptance, line items, public link `/project-quote/<id>?t=<token>`), not in
  `quotes`. So for a software client like Excel Technologies, Customer 360 → Transactions → **Quotes**
  shows only old `quotes` rows and never the project quotation the deal was actually made on, and
  `/quotes` has no row for it either. The owner reads that as "no quote was ever made".
  (Banking → Reconcile → Project payment → Naya project now creates the project as a quotation and
  accepts it — `create_project_quote` + `accept_project_quote` — so these projects have one.)
- **What to change:**
  1. `production/src/components/features/customers/customer-profile.tsx` — the Quotes filter / count
     (~line 91, 190–215) also lists the customer's projects as "Project quotation" rows (title, total,
     Quotation / Accepted on `accepted_at`), linking to `/projects/<id>`.
  2. `/quotes` list — either the same rows with a "Project" badge, or a visible link to Project Sales
     for project quotations. Do **not** copy them into `quotes`: that would double them in the quote
     pipeline and in Customer 360.
- **Done when:** Excel Technologies' "Complete ERP" quotation shows under Customer 360 → Quotes
  (and in `/quotes` or clearly linked from it).

- **Done by Abhishek (2026-09-26):**
  - **Item 1 — fixed, and this was the whole gap.** Customer 360 -> Transactions -> Quotes
    filtered on `type === "Quote"`, so it showed `quotes` rows and nothing else. It now counts
    project rows too. The project is not copied anywhere — it appears under both Quotes and
    Projects, which is true of it, and there is a test asserting nothing inserts into `quotes`.
  - Project rows read in **quote language** — Quotation / Accepted / Declined — via
    `lib/projects/quotation-view.ts`. Raw `quoted` / `active` under a "Quotes" heading means
    nothing to a reader. `accepted_at` wins over the status when both are present, because the
    timestamp is the event and the status is a summary of it; an older row with no timestamp
    still reads Accepted rather than inventing a date.
  - **Item 2 was already done, before the request was written.** `/quotes` has had a
    **Subscription | Project** toggle since commit `e04a81af`, 4 Aug 2026, and the Project tab
    lists every project sale with its customer and title. So "`/quotes` has no row for it
    either" was not true. I have left it alone rather than building a second route to the same
    list, and there is a test pinning the tab so the claim is checkable instead of something I
    said once.
  - Tests: `quotation-view.test.ts` (11) and `quotation-view.wiring.test.ts` (4).
  - **Verification:** test-verified, not browser-verified — no projects in this rebuilt local DB.

### R-007 · A customer can disappear from under its invoices
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** invoices, credit / debit notes and TDS entries are legal records; each
  must keep its customer for GSTR-1, the Ledger and Aging. Seen locally: invoices listed customers that
  no longer existed. That case was seed data (below), but the schema allows it for real data too:
  - `invoices`, `quotes`, `credit_notes`, `debit_notes`, `tds_receivable`, `project_sales` →
    `customer_id … ON DELETE SET NULL`: deleting a customer outside `delete_customer` (SQL, another
    code path, a future bulk delete) silently leaves those records with no customer.
  - `subscriptions` → `ON DELETE CASCADE`: the same delete **erases** the subscriptions.
  - `delete_customer` checks subscriptions / payments / invoices / quotes / projects, but not
    credit notes, debit notes or TDS entries — those would be orphaned by an allowed delete.
- **What to change** (one migration, Billing):
  1. Those foreign keys → `ON DELETE RESTRICT`, so the database itself refuses while any financial
     record points at the customer. (`payments.customer_id` already has no action — keep it.)
  2. `delete_customer`: also count `credit_notes`, `debit_notes`, `tds_receivable`.
  3. `supabase/seed.sql` (~line 83): the sample invoices insert only `customer_name`, never
     `customer_id`, and the names don't match the seeded customers ("Acme Corp" vs "Acme Corp Pvt
     Ltd") — link them, so a fresh local DB doesn't start with orphans. (Removed from Pardeep's local
     DB on 2026-09-25.)
- **Done when:** deleting a customer that has any invoice / note / TDS / subscription fails at the DB,
  and a fresh seed has no invoice without a customer.

- **Done by Abhishek (2026-09-26):**
  - Migration `20260926130000_customer_financial_records_restrict.sql`. `invoices`, `quotes`,
    `credit_notes`, `debit_notes`, `tds_receivable`, `project_sales` → **ON DELETE RESTRICT**;
    `subscriptions` **CASCADE → RESTRICT**. `payments` untouched (already NO ACTION).
  - It refuses to run if any row already points at a missing customer, naming the table and
    the count rather than letting Postgres report an opaque constraint violation.
  - `delete_customer` now counts credit notes, debit notes and TDS entries, and its refusal
    points at Archive (§24). The client twin `lib/customers/deletable.ts` takes the same three
    as optional counts — the customer profile does not load them, so in that one case the RPC's
    message reaches the operator as the error toast instead. Written down in the file rather
    than left to be discovered.
  - `supabase/seed.sql` — the five sample invoices now carry `customer_id`, and "Acme Corp"
    became "Acme Corp Pvt Ltd" to match the seeded customer. A fresh local DB starts with zero
    orphan invoices, verified.
  - Tests: `supabase/tests/customer_financial_records_restrict.test.sql`, which asserts FIRST
    that an empty customer still deletes (a wall that refuses everything passes every
    "is it refused?" test), then that an invoice, a subscription and a credit note each hold
    the customer in place. Red-checked. Plus 5 new cases in `deletable.test.ts`.
  - **One thing the red-check turned up, worth your knowing:** `invoices` already had a
    trigger-level guard — the immutability trigger refuses to null out `customer_id` on an
    issued invoice. So the orphaning measured here on 25 Sep was on **quotes**, which had no
    such guard. Invoices were exposed only while still in draft. The migration is still right
    for all seven tables; the invoice half was narrower than the request assumed.
  - ⚠️ **Behaviour change to expect:** deleting a customer that has any of these now fails at
    the database. That is the ask, and it is stricter than before — four customers were deleted
    directly on 25 Sep and that would now be refused.

### R-008 · Project quotations and the lead they came from
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26 (items 1 and 2; item 3 declined, see below)
- **Raised:** 2026-09-26
- **Why accounting / CRM needs it:** leads now have an enquiry type (migration
  `20260926110000_lead_enquiry_type.sql`, Pardeep's CRM). A custom-software lead's "Send quote" raises a
  **project quotation** through a new RPC `create_project_quote_from_lead`, which calls your
  `create_project_quote` unchanged and stores the link on **`leads.project_id`** (no change to
  `project_sales`). Your code is not touched. Three things are left on the Project Sales side:
  1. ~~**Won when accepted.**~~ **Done on Pardeep's side (2026-09-26)** — migration
     `20260926120000_lead_won_on_project_accept.sql` adds trigger `trg_leads_won_on_project_accept`
     **on `project_sales`** (AFTER UPDATE OF status): when a project becomes `active`/`completed`, its linked
     lead turns Won with a timeline entry. It writes only to `leads` / `lead_activities`; no project function
     changed. **Please do not add the same update to `accept_project_quote`** — and if you ever rename
     `project_sales.status` values, tell Pardeep, since the trigger keys on `active` / `completed`.
  2. **Show the source on the project page** (`/projects/[id]`): "From lead: <company> · <contact>" linking to
     `/leads?lead=<id>` — `select id, company, contact_name from leads where project_id = <project id>`.
  3. **"New quotation" in Project Sales / Customer 360** (`create-project-quote-dialog.tsx`): optional —
     when a quotation is made there for a company that has an open project lead, offer to link it
     (`update leads set project_id = …`), so a deal quoted from either side ends up connected.
- **Done when:** accepting a lead's project quotation turns the lead Won without a click, and the project
  page shows the lead it came from.

- **Done by Abhishek (2026-09-26):**
  - **Item 2 — the source lead is on the project page.** `useProjectSourceLead` in
    `lib/queries/projects.ts` reads `select id, company, contact_name from leads where
    project_id = <project>`; the header shows "From lead: <company> · <contact>" linking to
    `/leads?lead=<id>`, which the leads page already handles as a drawer deep-link. It renders
    only when there IS a lead — "From lead: —" on every other project would be furniture.
  - **Item 1 — not touched, as you asked.** `accept_project_quote` still does not mention
    leads; verified against the live function body, not the migration. There is now a test
    asserting no project file sets a lead's stage to won, so the trigger keeps its monopoly —
    an absence nobody can see in review.
  - Nothing on this side WRITES `leads.project_id`. Also asserted, because an update here
    would race your RPC and silently re-point a lead at a different project.
  - Tests: `lib/queries/project-source-lead.test.ts` (5), red-checked.
  - **Item 3 declined for now, and it is your call whether to push back.** Offering to link a
    Project Sales quotation to an open project lead means writing `leads.project_id` from the
    Billing side — a second writer for a column your RPC owns, to save a step in a case
    nobody has hit yet. If you want it, say so and I will build it your way; I would rather
    the CRM side keep sole ownership of that column.

<!-- Template — copy for each new request:

### R-001 · <short title>
- **For:** Abhishek | Pawan
- **Status:** Open
- **Raised:** YYYY-MM-DD
- **Why accounting needs it:** <what accounting feature is blocked or wrong>
- **What to change:** <file(s) / behaviour, as specific as possible>
- **Done when:** <how we can check it>

-->

## Done

R-001 to R-008 — all closed by Abhishek on 2026-09-26. They are left in place above rather
than moved down here, because each one now carries the reasoning for what was built and, in
three cases, for what was built differently. Cutting them loose from their requests would
strand both halves.
