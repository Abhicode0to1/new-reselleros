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

### R-009 · Renewal quotes: monthly subscriptions renewed for a year, and cost guessed at 83% of price
- **For:** Abhishek
- **From:** Pawan (checkout and renewals, `pawan-api-system`). Pardeep asked for it to be passed on.
- **Status:** Open
- **Raised:** 2026-09-25 (written up here 2026-09-26)
- **Where:** `production/src/lib/renewals/create-renewal-quote.ts`. That one file only; it is in your
  Billing folder, so nobody else edits it. Nothing else in the Billing folders should change unless
  Pardeep agrees.
- **Read first:** `AGENTS.md` at the repo root, especially:
  - §1: money is stored in whole rupees, not paise;
  - §2: never substitute a plausible-looking value, say it is unknown;
  - §9: "done" means the full gate is green;
  - L24 and L36: verify money changes in a rolled-back transaction, and run the WHOLE suite before
    believing a money diagnosis.

**How a renewal quote reaches a subscription.** `createOrGetRenewalQuote()` builds the renewal quote.
Its three callers:
- the renewals cron, `app/api/cron/renewals/route.ts` (around line 280);
- `app/api/renewals/send-now/route.ts:155`;
- `app/api/subscriptions/[id]/generate-renewal-quote/route.ts:93`.

When the quote is paid, the Postgres function `record_payment` rolls the subscription forward using the
quote's `extension_months` in three places:

```sql
-- the line after the subscription row is selected into v_renewal_sub
v_extension_months := v_quote.extension_months;      -- only falls back to sub.term_months when NULL

v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric
                               / greatest(v_extension_months, 1)))::int;
update public.subscriptions
   set renewal_state = case when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
                            then 'renewed' else renewal_state end,
       renewal_date  = (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date,
       mrr           = case when v_new_mrr > 0 then v_new_mrr else mrr end, ...
```

Live body: `select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'record_payment';`

**Bug 1: every renewal quote says it extends 12 months, monthly subscriptions included.**
Around line 221:

```ts
extension_months: 12,    // standard 1-year renewal; extensions use 24/36 via createExtensionQuote
```

The same file already prices the renewal for the subscription's own term. It calls
`renewalTerm({ termMonths })` and writes `commitment: term.commitment` ("monthly" for a 1-month
subscription). Only `extension_months` still says 12. When a MONTHLY subscription's renewal is paid:
- the renewal date moves 12 months instead of 1: the customer gets a year for one month's money;
- `mrr` becomes one month's subtotal ÷ 12, so MRR drops about twelvefold after the first renewal.

Measured on a local database inside a rolled-back transaction. Standard hosting, monthly, ₹250/month,
`term_months = 1`, renewal date 2026-10-25. Renewal quote as this helper writes it: subtotal 250,
`extension_months` 12, line commitment "monthly", amount ₹295. Then `record_payment`:

| field | before | after one ₹295 renewal | should be |
|---|---|---|---|
| `renewal_date` | 2026-10-25 | 2027-10-25 | 2026-11-25 |
| `mrr` | 250 | 21 | 250 |
| `term_months` | 1 | 1 | 1 |

`record_payment`'s own result also reported `"extension_months": 12`.

**Fix:** set `extension_months` from the term actually priced, e.g. `extension_months: term.termMonths`.
`renewalTerm()` already returns `termMonths` (`lib/renewals/renewal-term.ts`): 1 for monthly, 12 for
annual, anything in 1–60 passes through. The `existingQuoteId` path must not change a quote that already
exists. Leave `create-extension-quote.ts` alone: it deliberately uses 24/36 for multi-year extensions.

**Bug 2: cost is guessed as 83% of the price.** Around lines 185 and 217:

```ts
const perSeatCost  = Math.round((annualAmount * 0.83) / Math.max(1, input.seats));
...
total_cost: Math.round(annualAmount * 0.83),
```

A hardcoded 17% margin standing in for the real vendor cost. AGENTS.md §2 lists this exact pattern as a
known bug. On Google Workspace Business Starter the real cost is ₹110 per seat per month; the guess said
about ₹224, double. So the margin shown on every renewal quote is made up.

**Fix:** take the cost from the catalogue. The helper already reads the catalogue item (by `itemId`,
falling back to plan name) for `msrp`; read its wholesale cost column too (check `items` for the name,
e.g. `wholesale`):
- per seat: wholesale × the months in the term (the same months used for the price);
- `total_cost`: that per-seat cost × seats.

If the catalogue has no cost, do not guess. `quotes.total_cost` is nullable in the database, but the
generated TypeScript type says `number` and the quote screens read it as a number. Either:
- make those readers handle an unknown cost and show "cost unknown", or
- store 0 and show "cost unknown" wherever 0 means not known.

Pick one, and do not let 0 read as a 100% margin.

**Do NOT change:**
- `record_payment` or anything under `supabase/migrations`, unless you find it is wrong. Its use of
  `extension_months` is correct once the quote carries the right value.
- Domain renewals, `lib/domains/renewal.ts` (`createDomainRenewalQuote`): builds its own quotes at
  ResellerClub's live price, and the cron uses it instead of this helper for `vendor = 'domain'`.
  Not affected.
- The hosting renewal worker, `app/api/cron/renew-hosting/route.ts`: it reads the term from the quote
  line's `commitment`, not `extension_months`, so it is correct either way.

**Tests: prove it, don't just assert it.**
1. **Unit tests for the helper** (existing ones sit near `lib/renewals`, e.g. `renewal-term.test.ts`):
   - a monthly subscription's quote gets `extension_months: 1`; an annual one's gets 12;
   - an existing quote is returned unchanged;
   - the cost is the catalogue's wholesale × months × seats;
   - no catalogue cost is not a guess.

   Red-check: put 12 and 0.83 back and confirm the new tests fail.
2. **A SQL regression test** in `production/supabase/tests/`, rollback style (read two existing files
   for the convention). Build your own fixture tenant, customer and monthly subscription; never use
   live ids (AGENTS.md L11). Pay a renewal quote shaped like the fixed helper's output, and assert
   `renewal_date` moved exactly 1 month and `mrr` did not change. Then flip an assertion and see it go
   red (L23).
3. **The full gate** in `production/`: `npm run typecheck && npm run test && npm run lint`. Baseline on
   26 Sep 2026: 7,047 tests passing across 399 files. Run all 63 SQL tests too, not only yours; AGENTS.md
   §9 explains how to run them without mis-reading the report-style ones.

**Before shipping: check real data for damage.** Ask Pardeep before changing any data. Find renewals
already paid with the bug. In production, run:

```sql
select q.id as quote_id, q.tenant_id, q.extension_months, s.id as subscription_id,
       s.term_months, s.renewal_date, s.mrr, q.subtotal
  from quotes q
  join payments p on p.quote_id = q.id and p.status = 'received'
  join subscriptions s on s.tenant_id = q.tenant_id
 where q.is_renewal
   and q.extension_months = 12
   and exists (select 1 from jsonb_array_elements(q.line_items) li where li->>'commitment' = 'monthly')
   and s.term_months = 1
   and s.plan = (q.line_items->0->>'name');
```

Any rows are monthly subscriptions pushed a year ahead with a shrunken MRR. List them for Pardeep with
the correct renewal date and MRR. Don't fix them yourself.

- **Report back:** what changed, with `file:line`; the tests added and the red-check results; the gate
  numbers; and what the production query returned.
- **Done when:** a paid renewal of a monthly subscription moves `renewal_date` by exactly one month and
  leaves `mrr` unchanged (SQL test green), and no renewal quote carries a cost the catalogue didn't give.

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
