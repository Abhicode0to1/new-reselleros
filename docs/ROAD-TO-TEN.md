# What 10/10 would actually take

**Written 22 Aug 2026.** Every number here was measured against the live database or the
codebase today. Where I had previously said something from memory and it turned out wrong,
the correction is left on the page rather than quietly fixed — see §1.

---

## 0. First, a definition — otherwise the number means nothing

"10/10 as AI-enabled accounting software" cannot be scored without saying what the test is.
The one worth using here, because it is checkable:

> **An Indian cloud reseller can run their entire business on it, the numbers survive a CA's
> review, and the AI does the work a person would otherwise do by hand — without ever being
> the reason a number is wrong.**

Three clauses, and the third is the one most products fail. A model that drafts a reminder
cannot corrupt the books; a model that categorises spend or reads an invoice can. That is why
`lib/ai/money-guard.ts` exists in this codebase already, and why the categorisation work of
21–22 Aug deliberately used **less** AI, not more.

**A warning about the target itself.** Chasing the phrase "AI-enabled" is the wrong goal for
accounting software. Measured on this account, 22 of 39 bank lines are categorised correctly
by five string rules — instantly, free, and with a reason an accountant can argue with. No
model beats that on those lines, and a model's answer cannot be argued with at all. The
honest product claim is *"AI where AI is better, rules where rules are better, and code
verifies the money either way"* — which is a stronger claim than "AI-enabled", because it can
be kept.

---

## 1. Corrections to what I have been telling Pardeep

Three times in this session I named a gap from memory or from `LAUNCH_READINESS.md` and the
code disagreed. Recording it here because the pattern matters more than the individual
mistakes: **a doc in this repo is a hypothesis (CLAUDE.md §25.1), and so is my recollection.**

| I said | Measured today |
|---|---|
| "Bank-statement AI and invoice→entry don't exist — build them" | Both exist and are wired: `api/ai/extract-statement` (Gemini vision, PDF/image → rows), `api/ai/extract-bill` (3 call sites) |
| "AI is only text drafting" | Also: `classify-junk`, `scan-visiting-card`, `plan-project`, `feedback/triage`, `inbound-purchase`, plus `lib/ai/money-guard.ts` (18 tests) and `lib/ai/audit.ts` (10 tests) |
| "Razorpay is P0 missing" | **11 files**, both halves configured on the live tenant — `razorpay_key_id` AND `razorpay_webhook_secret` — but `razorpay_mode = 'test'` |

The one claim that held up: **GST e-Invoice is genuinely absent.** `invoices.gst_irn` exists,
22 invoices, **0 carry an IRN**, and there is no IRP integration anywhere in `src/lib` or
`src/app/api`.

---

## 2. Where it stands, measured

| | State |
|---|---|
| Tests | 3,319 passing · build clean · lint clean |
| Money spine | lead → quote → pay → subscription → invoice → renewal, test-backed |
| AI in place | statement reading, bill reading, card scanning, junk classification, drafting, project planning, triage — with a money guard and an audit trail |
| Categorisation | rules layer live; **22 of 39 lines** covered by 5 rules, zero AI calls; corrections become rules |
| Razorpay | built + configured, **test mode** |
| GST e-Invoice | schema ready, **integration absent** |
| WhatsApp | code present, **not configured** on the live tenant |
| **Real usage** | **1 tenant · 39 bank lines · 22 invoices · 35 expenses** |

That last row is the honest headline, and it is not a code problem.

---

## 3. The gap, in the order that actually moves the number

### Tier 1 — cannot launch to a paying stranger without these

**1. GST e-Invoice (IRP).** The only P0 that survived checking. Mandatory for B2B supply above
the turnover threshold, and a reseller who cannot issue an IRN cannot invoice a large customer
at all. The schema is already there; what is missing is the integration, the failure handling
(the IRP goes down, and an invoice that silently has no IRN is worse than one that refuses to
issue), and a cancellation path within the 24-hour window.

**2. Razorpay from test to live.** Not a build project — a switch, a real ₹1 transaction, and a
webhook that is observed to move the quote. `razorpay-readiness.ts` already encodes the trap
worth knowing: with `key_id` set but `webhook_secret` missing, the customer pays, Razorpay
POSTs, the route answers 401 and **nothing in the app moves**. Both halves are configured here,
so the remaining work is proving it end to end on live keys.

**3. Someone other than Pardeep using it for a month.** This is the real Tier 1 item and the
one that cannot be coded. Every bug found in this session — the quote that took ₹50,000 and
still asked "Customer accepted?", the subscription that was paid and said nothing, the
approvals queue that did not exist — was found by **looking at the screen**, not by 3,319
tests. One more real operator would find another dozen.

### Tier 2 — this is what "AI-enabled" would actually mean

**4. Phase 3 of categorisation.** AI on the 17 lines rules do not reach. Small, designed, and
cheap because Phase 4 shrinks it every month.

**5. A GST mismatch detector.** The highest-value AI in the whole product, and nobody sells it:
wrong rate, wrong place-of-supply, an HSN that does not match the item, input credit claimed on
a blocked category (CGST s.17(5) — gifts and food, which this codebase already comments on).
Every one is real money and every one is invisible until a notice arrives. `isInterStateSupply`
already exists; the work is having AI *check* rather than *compute*.

**6. Reconciliation suggestions.** `matched_to_type`/`match_confidence` already exist and are
filled in by hand. Proposing the match — this ₹54,938 credit is that invoice — is the single
biggest per-month time saving for an accountant, and it is verifiable: the amount either agrees
or it does not, so the model proposes and arithmetic decides.

### Tier 3 — needs time to pass, not work to be done

**7. Anomaly detection** ("this vendor bill is double last month's", "this customer's payments
stopped"). **8. Cash-flow forecasting.**

Both need history. **39 bank transactions and 22 invoices cannot support either**, and building
them now would produce something that demos and then embarrasses you. Revisit after six months
of real imports. Anyone who promises these on this data is guessing.

---

## 4. What cannot be shortcut, and should not be attempted

- **Compliance is not a feature you finish.** GST rules change; e-invoicing thresholds change.
  10/10 is not a state you reach and keep — it is a state you maintain.
- **A CA's sign-off.** Nothing in this list substitutes for an accountant reviewing a real
  filed return produced by this software. Until that has happened once, "the numbers survive a
  CA's review" is untested, however green the suite is.
- **The 3,319 tests do not cover the SQL side.** The 30 files in `supabase/tests/` are not in
  CI and not in the Stop hook. Any RPC change means running them by hand, or it is not verified.
- **Multi-tenant proof.** One real tenant has used this. Row-level hierarchy enforcement is
  written (`20260818150000_user_hierarchy_visibility.sql`) and **not applied**. A second paying
  reseller makes that a launch blocker rather than a note.

---

## 5. The shortest honest path

1. **Deploy what already exists.** As of now the live revision has the new `record_payment`
   behaviour but none of the UI built on 21–22 Aug. The production database is ahead of the
   production screen, which is the worst of the two orders.
2. **Razorpay to live**, and watch one real payment move a quote by itself.
3. **GST e-Invoice**, with the failure path designed before the happy path.
4. **Give it to one more reseller** and fix what they hit for a month.
5. *Then* Phase 3, the GST mismatch detector, and reconciliation suggestions — in that order.

Steps 1–4 contain almost no AI, and they are what stands between this and a product somebody
pays for. Step 5 is what makes the label true.
