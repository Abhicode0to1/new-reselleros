# ResellerOS V3 — Financial Statements Audit

_Audited 2026-08-12. Role/lens: financial-systems (controller-grade) review of the **statements**, not the transactions._

> **How this differs from `MONEY-FLOW-TEST-MATRIX.md`** — and why both are needed.
>
> That doc asks: *"is each transaction recorded correctly?"* (idempotent payments, one invoice per quote, correct GST head, atomic RPCs). It is largely green, and it earned that.
>
> This doc asks a **different** question: *"are the financial statements built on top of those transactions correct?"* A perfectly-recorded set of transactions can still roll up into a P&L and Balance Sheet that misstate profit — and that is exactly what was found. The spine being green does not make the statements right.

> ✅ **UPDATE 2026-08-12 — §7 was run against prod. Findings are now measured, not inferred, and F1 + F2 are FIXED.**
>
> | Finding | Measured in prod | Outcome |
> |---|---|---|
> | **F1** advances with no liability | **₹8,00,189** across 12 payments | 🔴 real + material → **FIXED** |
> | **F2** receivable on the wrong basis | Balance Sheet showed **₹0** vs **₹97,639** genuinely owed | 🔴 real → **FIXED** |
> | F3 depreciation missing | **₹0** — no fixed assets exist yet | 🟡 latent, deferred |
> | F4 no asset register | **0** assets tracked | 🟡 latent, deferred |
> | F6 customer credits off-sheet | **₹0** — none open | 🟡 latent, deferred |
>
> **Net effect of the fix: reported retained earnings drop by ₹7,02,550.** The sheet was overstating equity by that much — ₹8L of customer advances read as profit, while ₹97.6k of genuinely-owed invoices were invisible. Two errors, opposite directions, same statement, and (per §2) the plug guaranteed it still "balanced" throughout.
>
> ⚠️ **Correction to this audit's own F2 number.** F2 below implies ~₹7.82L was missing from the balance sheet. **That was wrong** — ₹6,85,000 of that is project-milestone invoices which `projectReceivable` *already* counts. Naively switching to "all unpaid invoices" would have **double-counted** it. The real subscription-side gap was **₹97,639**. Lesson: before changing an aggregate, check what the *other* aggregates on the same statement already include.
>
> Deferring F3/F4/F6 was the right call and the numbers prove it — they are genuine design gaps with **zero present impact**. This is why §8 step 1 was "run the query", not "fix the code".

---

## 1. How to read this

Severity here is about **numbers that leave the building** — what a CA files, what a bank sees, what you price against:

- **P0** — a figure you would **file or decide on** (Net Profit, taxable income, balance-sheet equity) is misstated, systematically.
- **P1** — the statements are internally inconsistent, or a real asset/liability is invisible. Wrong decisions, but not directly a filed figure.
- **P2** — presentational, or a caveat the code already documents.

"Overstates / understates" always refers to what the app **reports**, versus what a double-entry system would report.

---

## 2. The structural finding — the smoke alarm is disconnected

`lib/queries/balance-sheet.ts:12-14` documents the design honestly:

> *"derives Equity = Total Assets − Total Liabilities so the sheet always balances (retained earnings is the plug — standard for a single-entry books-lite setup)"*

Books-lite with a plug is a legitimate choice, and the docstring is upfront about it. **The consequence is what matters:**

In double-entry, a trial balance that does not balance is your **smoke alarm** — it tells you an entry went in wrong. Here, Equity is *computed* as the difference, so **the sheet can never fail to balance.** Any error in any asset or liability figure flows silently into "retained earnings" and the statement looks perfect.

So the useful question is never "does it balance?" (it always will). It is **"what is hiding in the plug?"** Sections 4's findings are answers to that question — each one is an amount currently being absorbed into retained earnings and read as profit.

---

## 3. At a glance

| Statement | Health | One line |
|---|---|---|
| **Expense journal** (`expenses`) | ✅ | Genuinely works as a single expense journal — payroll, EMI, claims, ESI, loans, reimbursements all post into it, linked back to source documents. Better than a spreadsheet by a wide margin. |
| **P&L — revenue** | ✅ | Accrual on invoice issue, taxable value only (never GST-inclusive), credit/debit notes netted. Correct. |
| **P&L — cost** | 🟡 | Salaries, employer ESI, COGS, commissions all present and correctly based. **Depreciation missing entirely** (F3). |
| **Balance Sheet — assets** | 🔴 | Cash/bank, TDS, employee loans, prepaid advances, project receivable all sound. **Trade receivable is on the wrong basis** (F2); **no fixed-asset register** (F4). |
| **Balance Sheet — liabilities** | 🔴 | Payables, salary payable, statutory dues, cards, EMI and business loans all sound. **Customer advances entirely absent** (F1); customer credits absent (F6); GST payable never reduced by GST paid (F5). |
| **Equity** | 🔴 | A plug. Absorbs every finding above and reports the total as retained earnings. |

---

## 4. Findings

| # | Finding | Sev | Direction of error |
|---|---|---|---|
| **F1** | Customer advances have no liability line | **P0** | Overstates equity / looks like profit |
| **F2** | Balance-sheet receivable is not the accrual receivable | **P0** | Both ways — hides owed money, counts unbilled money |
| **F3** | No depreciation in the P&L | **P0** | Overstates Net Profit + taxable income |
| **F4** | No fixed-asset register (EMI purchases only) | **P1** | Cash-bought assets unrecordable |
| **F5** | GST payable is cumulative FY, never reduced by GST paid | **P1** | Overstates liabilities, grows through the year |
| **F6** | `customer_credits` missing from the Balance Sheet | **P1** | Understates liabilities |

---

### F1 — Customer advances have no liability line · **P0**

The money spine issues a **Receipt Voucher** for an advance (CGST §31(3)(d)) — so the system *already knows* the money is an advance. But:

| | |
|---|---|
| Advance cash | → `cashAndBank`, an **asset** ✅ |
| Revenue | → **not** recognised (P&L is accrual on invoices) ✅ correct |
| Matching liability | → **nothing** ❌ |

Grep for `unearned`, `customer_advance`, `advances from customer` across `lib/queries/` and `app/(app)/accounting/`: **zero matches.** The `BalanceSheetAuto` interface (`balance-sheet.ts:32-49`) has no such field.

**Worked example.** Customer pays ₹1,18,000 in April as an annual advance; no invoice raised yet.

```
Bank                    +₹1,18,000   (asset  ↑)
P&L revenue                     ₹0   (correct — not earned yet)
"Advance from customer"         ₹0   ← should be ₹1,18,000 (liability)
─────────────────────────────────────────────────────────────
Equity plug = Assets − Liabilities = +₹1,18,000 of "retained earnings"
```

The Balance Sheet reports ₹1,18,000 of earnings the business **has not earned**. It is customer money that is still owed as service.

**Why it is systematic, not occasional:** this is an annual-advance subscription business. Collecting in advance is the core cash-flow pattern, so the error is present by design of the business model, not by accident.

**Fix — no migration needed.** Computable from existing data: sum `payments` (status `received`) whose quote has no invoice yet. Add it as an `advancesFromCustomers` liability in `useBalanceSheetAuto()`. Once the invoice is raised, `invoices.adjusted_advances` already freezes the adjustment (`0005`), so the liability naturally unwinds — the data model already supports this; only the presentation is missing.

---

### F2 — Balance-sheet receivable is not the accrual receivable · **P0**

Three surfaces, two incompatible definitions:

| Surface | Definition | Basis |
|---|---|---|
| **P&L** revenue (`pnl/page.tsx:120-122`) | invoices issued in period | accrual ✅ |
| **Aging report** (`accounting/aging/page.tsx:65`) | unpaid / partly-paid invoices | accrual ✅ |
| **Balance Sheet** trade receivable (`balance-sheet.ts:80-86`) | `subscriptions.outstanding_amount > 0` | **quote expected − received** ❌ |

Two distinct errors follow:

1. **Money genuinely owed is invisible.** A direct invoice (`create_direct_invoice`, `0158`/`0159`) has no subscription row, so an unpaid one contributes ₹0 to the balance sheet. Example: a ₹50,000 one-off invoice, unpaid → **Aging report shows ₹50,000, Balance Sheet shows ₹0.**
2. **Money not yet owed is counted.** A subscription can carry `outstanding_amount` before any invoice exists. That is not a legal receivable yet — nothing has been billed.

**Consequence:** revenue (accrual) and receivables (quote-based) cannot be tied to each other. A CA reconciling *revenue recognised ↔ receivables + cash collected* will not get it to agree, and neither will you.

**Note the irony:** the **project** path already does this correctly — `balance-sheet.ts:105` counts only milestones that have an `invoice_id`, with the comment *"a milestone becomes a receivable when its Tax Invoice is raised."* That is exactly the right rule. The subscription path just doesn't follow it.

**Fix:** make the balance-sheet receivable accrual-based (unpaid `invoices.net_payable`), matching the Aging report and the project path. Keep `outstanding_amount` for collections/chasing UX, where it is genuinely useful — it is a *collections* metric, not a balance-sheet one.

---

### F3 — No depreciation in the P&L · **P0**

`netProfit = grossMargin − expensesTotal − commissions` (`pnl/page.tsx:205`). No depreciation term.

Depreciation exists in the app **only** as a manual Balance Sheet contra line (`accounting/balance-sheet/page.tsx:539`, `{ value: "depreciation", label: "Depreciation (–)", contra: true }`), with **no link to the P&L**. So entering it fixes the asset side and never touches reported profit.

**Impact:** Net Profit and taxable income are overstated by the depreciation charge for anyone owning assets. The app's own compliance module already knows this is required — `lib/compliance/obligations.ts:231` lists *"depreciation as per IT Act"* as an ITR step.

**Mitigation that exists today:** a diligent CA can compute and adjust outside the app. That works, but it means the app's Net Profit is not the filed Net Profit — which undermines the point of the P&L page.

---

### F4 — No fixed-asset register · **P1**

`/accounting/assets/page.tsx:36` reads `useEmiPurchases()` — nothing else. It is an **EMI-purchases page wearing an "Assets" label.**

- A laptop bought **with cash** cannot be recorded as an asset at all.
- `fixedAssets` on the Balance Sheet = `SUM(emi_purchases.total_cost)` (`balance-sheet.ts:144`) — original cost, **undepreciated forever**.

Feeds F3: with no register there is nothing to depreciate *from*, so F4 should be fixed before or with F3.

---

### F5 — GST payable is cumulative FY, never reduced by GST paid · **P1**

`balance-sheet.ts:198-236` computes `gstPayable = outputGST − billsGst − expGst` **for the whole fiscal year to date**. There is **no `gst_payments` table anywhere** in the 196 migrations, so GST already remitted is never subtracted.

GST is filed and paid **monthly**. In August (month 5 of FY 2026-27) roughly **four months of already-paid GST still shows as a liability**.

The code footnotes this honestly (*"an estimate before any GSTR filing/payment"*), so it is a known caveat rather than a bug — but the error **grows monotonically through the year** and is at its worst in March, exactly when the numbers matter most.

**Fix:** record GST challans (a small `gst_payments` table, or an `expenses` category convention) and subtract them.

---

### F6 — `customer_credits` missing from the Balance Sheet · **P1**

`customer_credits` exists (`0141`/`0142`) with `amount integer` and `status in ('open','used','refunded')`. An **open** credit is money owed back to the customer — a liability. It appears nowhere in `BalanceSheetAuto`.

**Fix:** add `sum(amount) where status = 'open'` as a liability. One query, no migration.

---

## 5. What is verified correct (so this audit is fair)

These were checked and are right — several are more sophisticated than typical:

- **Output GST uses the FROZEN per-invoice `tax_amount`**, never a hardcoded 18% (`balance-sheet.ts:206-215`) — so a zero-rated export is not wrongly taxed. Genuinely careful work.
- **Credit / debit notes net both revenue and output GST** (`pnl`, `balance-sheet`) — correct sign handling on both.
- **Payroll posts exactly one expense row** per salary, amount = **earned gross (gross − LOP), not net** — the correct employer cost — linked via `salary_payments.expense_id` so it reverses cleanly on delete (`0087:176`, `0120`). **No double-post between accrual and payment.**
- **Employer ESI (3.25%) booked as a separate `statutory` expense** (`0140:92`) — an additional company cost that is easy to miss, and wasn't.
- **Salary payable vs statutory dues correctly split** — unpaid net sits as payable; withheld TDS/PF/ESI on *already-paid* salaries sits as a government due, net of `statutory_dues_payments`.
- **Credit cards treated as liabilities**, with an overpaid card correctly falling back to cash (`balance-sheet.ts:71-76`).
- **Project receivable is accrual-correct** (invoiced milestones only) — the pattern F2 should copy.
- **Reimbursements payable** correctly recognises that the expense already hit the P&L and only the payable remains.

**Incidental finding (helps an old open question):** `customer_credits.amount` is commented `-- ₹, always positive` (`0141:11`). The newer tables consistently document **whole rupees**, which is evidence for closing the long-standing rupee-vs-paise ambiguity (`MONEY-FLOW-TEST-MATRIX` #36, `PROJECT-KNOWLEDGE` §14) in favour of **₹**.

---

## 6. Not examined

Stated so nothing here is mistaken for a full-scope audit:

- **Cash Flow statement** (`accounting/cash-flow/page.tsx`) — not reviewed.
- **SaaS Metrics / Profitability / Customer Aging bucket math** — not re-reviewed (Aging's known dead-`b90` bucket bug is recorded in `PROJECT-KNOWLEDGE` §8).
- **`petty_cash`, `balance_sheet_items` manual lines, `advances`, `tds-receivable` year-end** — not traced.
- **No live data** — see the basis note at the top. Directions are asserted; magnitudes are not.

---

## 7. Run this first — turn the findings into rupees

Run as an owner in the Supabase SQL editor (RLS scopes it to your tenant). This tells you whether any of the above matters **today**.

```sql
-- F1: advances received with no invoice yet = the missing liability
select coalesce(sum(p.amount), 0) as f1_advance_liability_missing
from   public.payments p
join   public.quotes   q on q.id = p.quote_id
where  p.status = 'received'
  and  q.invoice_id is null;

-- F2: the two receivable definitions, side by side. They should be close;
--     a large gap confirms the basis mismatch.
select
  (select coalesce(sum(outstanding_amount), 0) from public.subscriptions
    where outstanding_amount > 0 and written_off_at is null)      as f2_balance_sheet_basis,
  (select coalesce(sum(coalesce(net_payable, amount)), 0) from public.invoices
    where status in ('pending', 'overdue'))                        as f2_accrual_basis;

-- F3/F4: asset base that has never been depreciated (and EMI is the ONLY source)
select count(*) as f4_assets_tracked, coalesce(sum(total_cost), 0) as f3_undepreciated_base
from   public.emi_purchases;

-- F6: open customer credits = a liability that is not on the sheet
select coalesce(sum(amount), 0) as f6_missing_liability
from   public.customer_credits
where  status = 'open';
```

Interpretation: any non-trivial `f1_advance_liability_missing` or `f6_missing_liability` is currently being reported as **retained earnings**. A large `f2` gap means your Balance Sheet and Aging report disagree about what customers owe you.

---

## 8. Recommended order

1. **Run §7.** Everything below is prioritised by what those numbers say. Do not refactor on the strength of a code read alone.
2. **F1 + F6** — both are query-layer additions to `useBalanceSheetAuto()`, **no migration**, and F1 is the largest single distortion. Cheapest fix, biggest correction.
3. **F2** — a definition decision first (accrual receivable on the Balance Sheet, `outstanding_amount` kept for collections), then a small change. Copy the project path's rule.
4. **F5** — needs a place to record GST challans; small, and it stops the error compounding toward March.
5. **F4 → F3** — a real fixed-asset register, then depreciation flowing into the P&L. Largest piece of work, and the one to do **with your CA**, not ahead of them — the schedule and rates are their call, not an engineering decision.

**Not recommended:** converting to full double-entry. It is the textbook answer and it is the wrong trade here — it would touch every money surface in a 196-migration codebase for a business with no paying tenants yet. Books-lite plus the fixes above gets statements a CA can sign, at a fraction of the risk. Revisit only if multi-entity consolidated reporting is ever sold as a feature.
