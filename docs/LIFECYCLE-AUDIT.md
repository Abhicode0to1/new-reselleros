# 10-Stage Lifecycle Audit — ResellerOS

**Date:** 13 August 2026
**Scope:** the full business chain, Lead → Tax Filing, against the brief's goal of
*"zero manual data re-entry"*.
**Method:** code survey plus direct measurement against the production database
(tenant *Anutech Digital*, `fbb976f1`). Every number below is counted, not estimated.

---

## The headline

Two findings matter more than the rest, and they point in opposite directions.

**The data chain is genuinely intact.** Records carry their parents. A quote knows
its lead, a payment knows its quote, an invoice knows its quote. This is the hard
part of "zero re-entry" and it is done.

**The automation on top of that chain has never run.** Not once. Every payment in
production was typed by a human. The links exist because the operator created each
record *from* its parent screen — not because anything fired by itself.

So the brief's goal is half-achieved in the way that is easiest to mistake for
whole: the database looks exactly as it would if the automation were working.

| Hand-off | Linked | Reality |
|---|---|---|
| Lead → Quote | 38/41 (93%) | operator opens the quote builder from the lead |
| Quote → Payment | 36/36 (100%) | operator records the payment on the quote |
| Quote → Invoice | 26/28 (93%) | generated from the quote |
| Payment → Subscription | 38/38 (100%) | created by `record_payment` |
| **Payment created by the Razorpay webhook** | **0/36 (0%)** | **every one entered by hand** |
| Subscription → provisioned licence | **0/38** | `external_ref` empty on every row |

---

## Stage by stage

### Stage 1 — Lead ingest ✅ built, and actually used

Eight distinct sources in production, so this is not theoretical:

```
whatsapp 23 · manual 14 · buy-workspace-v2 7 · referral 7
tele-calling 6 · csv 2 · email-inbound 2 · enquiry-form 1
```

Inbound routes exist for email, WhatsApp, purchase and Google CSV import. 48 of 62
leads arrived through a channel rather than manual entry.

### Stage 2 — CRM pipeline ✅ built

62 leads distributed `won 32 · quote 11 · contact 8 · lost 7 · new 4`. Heat scoring,
stale-deal detection and loss-reason capture were added earlier in this work.

### Stage 3 — Quote builder ✅ built · ⚠️ one gap

Templates, branded PDF, public accept link, GST computation all present. **The
invoice PDF now carries a scan-to-pay UPI QR; the quote PDF does not.** The brief
asks for both. Small, unblocked work.

### Stage 4 — Razorpay checkout & webhook ⚠️ **built and dead**

The webhook is well-built: HMAC SHA-256, per-tenant signing secret, fail-closed,
tenant-mismatch rejection, idempotency inside `record_payment` via reference dedupe.

It has never processed a single event. `razorpay_webhook_secret` is null, so every
event is answered 401. All 11 payments recorded with method `razorpay` were typed in
by hand — their references are `8734uhrwekjfb`, `9485ujt94tu`, not `pay_…`.

The stored key is `rzp_test_`, so **no real customer money is being lost today**.
This becomes real money the day a live key is saved — which is exactly the day
nobody would think to check. Now surfaced by the money-health card.

### Stage 5 — Licence provisioning ❌ **not built**

The single largest genuine gap in this brief.

What exists is a **read-only** Google Reseller API integration that imports existing
subscriptions. There is no write path: no Cloud Channel provisioning, no Microsoft
Partner Center adapter at all. `external_ref` is empty on all 38 subscriptions,
which is the measurable proof that nothing has ever been provisioned through the app.

Today, after a payment, someone opens the Google Admin console and does it by hand.

**Why this was not built here.** It needs Google Partner Advantage / Cloud Channel
API access and a Microsoft Partner Center app registration — credentials and
approvals that cannot be obtained from inside the codebase. An adapter written
without them could not be run or verified even once. Given that this session found
three separate features that were built, looked configured, and did nothing, adding
a fourth unverifiable one would be the worst possible response to that pattern.

### Stage 6 — GST invoice & receipt voucher ✅ built

`ReceiptVoucherPDF` and the tax-invoice path both exist, with CGST/SGST/IGST split
and place-of-supply logic. Invoice PDFs now carry a UPI QR whose amount is the real
outstanding balance.

### Stage 7 — Vendor PO & 3-way match ⚠️ **built, starved of data**

45 purchase orders. **1 vendor bill.** Three-way matching needs all three sides;
two of them are effectively absent, so gross margin per customer cannot be computed
from real data no matter how good the matching code is. This is a data-entry gap,
not a code gap.

### Stage 8 — Renewal cadence ✅ built, correct, unexercised

Seven touches (T-15/12/9/6/3/0 plus grace, then auto-suspend) — **more than the
brief's five**. All 38 subscriptions are `active`, `auto_renew=true`, with renewal
dates 343–365 days out. The earliest is 2027-07-22, so the first real reminder is
~11 months away and the empty `renewal_email_log` is correct behaviour.

The risk is that a healthy engine and a dead one produce the identical empty log for
eleven months. A dry-run mode was added: `?dry=1&on=YYYY-MM-DD` rehearses any date.
The full ladder was verified this way — six escalating emails then suspend at T+3.

**But email is in stub mode** (`RESEND_API_KEY` unset locally). A fired reminder
would be logged as sent and delivered to nobody. Needs confirming on the deployment.

### Stage 9 — Customer portal ✅ built

Passwordless one-time-code login, invoices, orders, subscription, support, shop.

Worth noting: it uses an emailed **code**, not a magic link, and the code says why —
email scanners follow links and consume the single-use token, so customers arrived
at "link invalid or expired". That is a good decision that a rewrite would undo.

### Stage 10 — Analytics & tax compliance ✅ built

MRR is computed exclusive of GST at the database level (migration 0057). A/R aging
uses four buckets (0-30/31-60/61-90/90+) where the brief asked for three. TDS
receivable is captured atomically with the payment (migration 0150) — 14 rows in
production — with a Form 26AS year-end tracker.

GSTR-1 and GSTR-3B export as **CSV in GST Offline Tool format**, not the JSON the
brief specifies. This looks like the better choice and should probably stand: the
Offline Tool is what a CA actually uses, and hand-built JSON that the portal rejects
is worse than a CSV that imports.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run test` | 365/365 |
| `npm run test:e2e` | 8 passed, 0 failed, **70 skipped** |

The e2e suite deserves its own note, because it was not a safety net.

- 2 tests failed for an environmental reason: the auth-gate test ran against a dev
  server with `NEXT_PUBLIC_DEMO_MODE=true`, which disables the very gate it checks.
  The suite now starts its own server on port 3100 with demo mode off. Both pass.
- 70 tests skip with "Set … in `.env.test` to enable" — and **nothing read that
  file**. No dotenv import, no globalSetup, dotenv not even a dependency. The
  instruction was impossible to follow. Now loaded, deliberately without falling
  back to `.env.local` so a write-heavy suite cannot silently point at production.
- `.env.test` was **not gitignored**, and it is the one env file documented to hold
  a service-role key. Fixed.

The 70 remain skipped by choice: unskipping them means seeding test tenants into the
production project, since there is no staging. See `.env.test.example`.

---

## What to do next, in order

1. **Add the Razorpay webhook secret.** Five minutes. Until then Stage 4 → 5 → 6 → 8
   is manual, and it will fail silently the day a live key is saved.
2. **Confirm `RESEND_API_KEY` on the deployment.** Otherwise every automated message
   in the product is logged and never sent.
3. **Push.** 650+ commits exist on one laptop.
4. Stage 3 gap: UPI QR + pay link on the quote PDF.
5. Stage 7: record vendor bills, or 3-way matching stays theoretical.
6. Stage 5: obtain Google Cloud Channel and Partner Center access. This is
   procurement and approvals, not engineering — and it is the biggest remaining
   source of manual work.

---

## A correction worth recording

Earlier in this work I reported the Razorpay gap with more urgency than the evidence
supported, before checking the key prefix. The key is `rzp_test_`. No customer money
is at risk today. The gap is real and worth fixing, but it is a landmine, not a fire.

The same discipline applies to Stage 8: I suspected the renewal cadence was broken
because its log was empty. Measuring it showed the log is empty because nothing is
due for eleven months. The cadence is fine. An empty table is evidence of nothing
until you know what should have filled it.
