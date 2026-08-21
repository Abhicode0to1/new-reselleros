# Bank transaction categorisation — plan

**Written 22 Aug 2026.** Every number here was measured against the live database, not
estimated. Where a number kills an idea, the dead idea is left on the page with the reason,
because the next person will otherwise have it again.

---

## 1. What already exists (measured, and it is more than I first said)

I told Pardeep twice that bank-statement AI did not exist and should be built. That was
wrong, and it was wrong from impression rather than from reading the code — the same
mistake this repo's own §25.1 warns about, minus the excuse of a stale doc.

| Piece | Where | State |
|---|---|---|
| Statement → rows | `api/ai/extract-statement/route.ts` | **Works.** Gemini vision, PDF or image, returns `{txn_date, description, debit, credit, balance_after}` |
| Import UI | `components/features/banking/import-statement-dialog.tsx` | **Works.** Operator previews every row before import |
| Vendor bill → form | `api/ai/extract-bill/route.ts` | **Works**, wired in 3 places |
| Money verification | `lib/ai/money-guard.ts` | **Works**, 18 tests |
| AI decision audit | `lib/ai/audit.ts` | **Works**, 10 tests |

So extraction is done. **What is missing is exactly one step: naming what each row IS.**
`extract-statement` contains the word "categor" zero times, and `bank_transactions` has no
category column.

### What the table has instead, and why it is not the same thing

`bank_transactions` carries `matched_to_type`, `matched_to_id`, `match_confidence`. That is
**reconciliation** — tying a bank line to a record that already exists (a payment, an
expense, a salary). Categorisation is the other case: a line with nothing to tie to, which
still needs to land somewhere in the books.

Both are needed and they are not competitors. Reconciliation should always run first: a
line that matches a real expense row does not need a guess, it needs a link.

---

## 2. The measurement that decides the architecture

The obvious pitch is "AI learns from your past categorisations". The data says no:

| Signal | Count |
|---|---|
| Bank transactions | **39** |
| ...already matched | 20 |
| Expenses | **35** |
| ...categorised | 35 (all) |
| Distinct categories | **8** |

35 examples across 8 categories, and it is not even spread — `Salaries` is 22 of the 35,
and four categories have one or two rows each. That is roughly **four examples per
category**, with a long tail of one.

**So: no training, no fine-tuning, and no "the model learns your business" claim.** Anything
built on that premise would be a demo that degrades the moment it meets a category it has
seen once. What 35 examples ARE enough for is few-shot context in a prompt — they fit
comfortably — and that is how they will be used.

### The other measurement, which is the good news

Three real unmatched narrations from the live table:

```
IMPS-621856395591-PARDEEP SHARMA-ICIC-XX XXXXXX4658-SALARY   ₹1,50,000 debit
DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL                             ₹3,024 debit
K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK                                 ₹5,000 debit
```

The answer is **written in the narration**. `SALARY` is the literal word. `PLAYSTOREGOOGL`
is Google Play. `PAYUFACEBOOK` is a Facebook ad payment through PayU. A plain string rule
gets all three right, instantly, for free, with a reason a human can check.

This is the whole shape of the plan: **most of this job does not need AI, and the part that
does should be the leftovers.**

---

## 3. Architecture: rules first, AI for the remainder, confirmation makes rules

```
bank line
   │
   ├─ 1. already reconciled?  ────────────────►  link it, no category guess needed
   │
   ├─ 2. does a tenant rule match?  ──────────►  suggest that category  (free, instant,
   │                                              explainable: "matched rule FACEBOOK")
   │
   ├─ 3. otherwise, ask Gemini once  ─────────►  suggest, with the tenant's own 8
   │      (batched, with the 8 categories +      categories as the ONLY allowed answers
   │       few-shot examples as context)
   │
   └─ 4. operator confirms or corrects  ──────►  WRITE A RULE from the confirmation
                                                 → next month step 2 handles it, and the
                                                   AI call is never made again
```

Step 4 is the part that matters. Every correction makes the deterministic layer bigger and
the AI bill smaller. The system improves without anyone training anything, and the
improvement is inspectable — a table of rules an accountant can read, not weights.

### Non-negotiables, inherited from what is already in this codebase

- **Never auto-post.** Every existing AI route in this repo says "ZERO money-write" and
  returns suggestions for review. Categorisation feeds P&L and GST input credit, so it gets
  the same posture: suggest, operator confirms, then write.
- **The model picks from a closed list.** It receives the tenant's 8 categories and may
  return one of them or `null`. A free-text category invents chart-of-accounts entries,
  and an accounting system whose account list grows by hallucination is worse than one with
  no AI at all.
- **Confidence is stored, and low confidence is visible.** `match_confidence` already
  exists as a precedent. A guess presented with the same certainty as a rule hit is the
  failure mode that makes an operator stop reading.
- **Every AI decision goes through `lib/ai/audit.ts`.** It already writes to `activity_log`.
- **Money is never restated by the model.** `debit`/`credit` come from the extracted row and
  are passed through untouched; the model is only asked for a label. `lib/ai/money-guard.ts`
  exists because a prompt instruction is a request, not a constraint — so the amount simply
  never travels back out of the model.

---

## 4. Phases

Each phase ends green on its own, and each is useful even if the next never happens.

### Phase 1 — the column and the rules table *(no AI at all)*

Migration:
- `bank_transactions.category text null`, `category_source text null`
  (`'rule' | 'ai' | 'manual'`), `category_confidence int null`
- `txn_category_rules` — `tenant_id`, `pattern text`, `category text`, `match_type`
  (`contains` | `regex`), `hit_count int`, `created_from_txn_id`, RLS by tenant

Seed the rules from what is already known: the 8 categories, plus patterns derived from the
35 categorised expenses and the 20 matched lines. That seeding is a script whose output is
reviewed, not a blind insert.

**Done when:** a pure `categoriseByRules(description, rules)` module is green, including
the three real narrations above as test cases, and a mutation proves the tests can fail.
No screen changes yet.

### Phase 2 — show it in the import dialog

The preview already lists every row. Add a category column with the suggestion, the reason
("rule: FACEBOOK"), and an editable dropdown of the 8 categories. Confirming the import
writes categories along with the rows.

**Done when:** importing a real statement shows a suggestion on the lines a rule covers and
a clearly-empty cell on the rest — empty, not guessed, and not silently blank in a way that
reads as "no category needed" (the exact bug fixed in the subscription card on 21 Aug).

### Phase 3 — AI for the leftovers

`POST /api/ai/categorise-transactions` — batch of uncategorised descriptions in, one of the
tenant's categories or `null` out, per row, with a confidence. Same shape and same auth as
the existing `classify-junk` route, which is the closest precedent: a batch classifier that
writes nothing.

**Done when:** the route is tested against the live unmatched rows, and a row the model is
unsure about comes back `null` rather than a low-confidence guess dressed as an answer.

### Phase 4 — corrections become rules

When an operator changes a suggested category, offer to remember it: "Always file
`PAYUFACEBOOK` under Marketing?" One click writes a rule.

**Done when:** a corrected transaction produces a rule, and re-running categorisation on a
similar line hits the rule instead of the AI. That is the test — not that a rule row exists,
but that the AI call stops happening.

---

## 5. Cost, before building anything (§25.5)

- Phases 1, 2 and 4 make **zero** AI calls. They are string matching and UI.
- Phase 3 makes one batched text call per import. At 39 transactions total in the live
  database, this is a rounding error on the Gemini bill, and it shrinks every time somebody
  confirms a correction.
- The expensive alternative — a trained classifier — is ruled out by the 35-row measurement
  above, not by preference.

**The honest expectation.** With 8 categories and narrations this pattern-heavy, rules alone
should handle most recurring spend, because recurring spend is exactly what has a stable
narration. AI earns its place on one-offs. Anyone promising "95% automatic" from this data
is guessing; the way to find out is to build Phase 1 and count the hits on the 19 unmatched
lines that exist today.

---

## 6. What this plan deliberately does not do

- **No GST rate checking.** Related, genuinely missing, and a separate piece of work with
  its own correctness risk.
- **No anomaly detection or forecasting.** Both need history this database does not have
  yet — the same 39-row problem. Worth revisiting after a few months of real imports.
- **No auto-reconciliation changes.** `matched_to_*` is a working mechanism and this plan
  sits beside it, not on top of it.
