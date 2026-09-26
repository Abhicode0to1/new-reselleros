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

## Open

### R-001 · `useCreateCustomer` can put a customer in the wrong company, or report a fake one
- **For:** Abhishek
- **Status:** Open
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

### R-002 · "New project sale" should pick a real customer, not a typed name
- **For:** Abhishek
- **Status:** Open
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

### R-003 · Milestone invoices are back-dated, so invoice numbers and dates go out of order
- **For:** Abhishek
- **Status:** Open
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

### R-004 · Edit an active project — contract value, title, customer
- **For:** Abhishek
- **Status:** Open
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

### R-005 · Customers list ignores project sales — a software client shows "No subscription, ₹0"
- **For:** Abhishek
- **Status:** Open
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

### R-006 · Project quotations don't appear under "Quotes"
- **For:** Abhishek
- **Status:** Open
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

### R-007 · A customer can disappear from under its invoices
- **For:** Abhishek
- **Status:** Open
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

### R-008 · Project quotations and the lead they came from
- **For:** Abhishek
- **Status:** Open
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

### R-009 · Invoice list: show credit / debit notes, the invoice date, and no stray "0"
- **For:** Abhishek
- **Status:** Open
- **Raised:** 2026-09-26
- **Why accounting needs it:** on 26 Sep an invoice of ₹23,60,000 carried a ₹17,70,000 credit note (net
  ₹5,90,000). The list showed only "₹23,60,000 · paid", which read as ₹23.6L received — the owner called it
  "bada confusing". The note was visible only inside the invoice. Two display bugs sat next to it.
- **What to change** — `production/src/app/(app)/invoices/page.tsx`:
  1. **Notes on the row.** When an invoice has credit / debit notes, show them under the amount, e.g.
     `CN −₹17,70,000 · net ₹5,90,000` (debit: `DN +₹50,000`). The detail view already loads them
     (`Credit & debit notes (n)`, ~line 1600) — the list needs the same totals per invoice.
  2. **Mobile / narrow card date (~line 855):** it prints `inv.created_at`; it should print
     `inv.invoice_date` like the desktop row (~line 954). An invoice dated 7 Aug showed "26 Sept 2026"
     because it was created on 26 Sep.
  3. **Stray "0" (~line 848):** `{inv.net_payable && inv.net_payable !== inv.amount && (…)}` renders a
     literal `0` when `net_payable` is 0 (React prints the falsy number). Use
     `inv.net_payable != null && inv.net_payable !== inv.amount` and show "Net: ₹0 · settled" or nothing.
- **Done when:** an invoice with a note shows the note and the net on its row; every row shows the
  invoice date; no bare "0" appears under a settled invoice's amount.

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

_None yet._
