# ResellerOS V3 — UX / Interaction Audit

_Audited 2026-08-12. Lens: product design for complex enterprise workflows + non-technical Indian SMB users — layout, logic, and **human behaviour** (cognitive load, muscle memory, defaults, trust on money screens)._

> **How this differs from the layout audits already in `TASKS.md`** (rounds 1 & 2, ~100 findings).
>
> Those were **layout** audits: padding, max-widths, mobile card fallbacks, FABs, dead buttons, breadcrumbs, copy language. Largely mechanical, and largely fixed.
>
> This one asks a **behavioural** question instead: *what happens to a real person using this?* — what they see first, what they do by default, what happens when something goes wrong, and how much they must hold in their head. It deliberately avoids re-listing anything those rounds already caught.

> ⚠️ **Basis — read before acting.** Every finding below is **code-measured** (counts + `file:line`), not opinion. But the screens were **never viewed in a browser** — the dev server stalled compiling heavy pages during the audit. So this doc contains **no judgement on visual hierarchy, contrast, spacing, typography or real mobile feel**, and the project's own `design-critique` / `accessibility-review` skills were **not run**. Those need eyes on live screens and remain outstanding.

---

## 1. How to read this

Severity is measured in what it costs the **user**, not the developer:

- **P0** — the user gets **stuck with no way forward**, or is shown a **wrong number**.
- **P1** — error-prone or high-friction: the user can get there, but is likely to get it wrong or give up.
- **P2** — inconsistency / polish. Real, but nobody is blocked or misled.

---

## 2. The structural finding — prevention is engineered, recovery is not

This is the thesis of the whole audit:

> **This app is excellent at *preventing* errors and weak at *recovering* from them.**

**Prevention is genuinely engineered.** Smart defaults, DB-level guards, atomic RPCs, payment idempotency, styled confirmation dialogs, and — the best single example — the payment amount that stays locked to `remaining − TDS − appliedCredit` until the user hand-edits it, *"so net + TDS always settles the quote EXACTLY"* (`record-payment-dialog.tsx:237-240`). That one default eliminates an entire class of ₹-few rounding disputes. Someone thought hard about this.

**Recovery is not engineered.** Of **278** `toast.error` calls, **3** carry a `description` and **1** carries an action button. The rest are a single red line with no reason and no next step — most of them literally `toast.error((e as Error).message)`, a raw Postgres/RPC error shown to a non-technical user.

**Why this asymmetry is natural — and why it is about to invert.** Prevention is visible to whoever builds the feature, because they exercise the happy path constantly. Recovery only becomes visible when a *real* user gets stuck. So far the only real user is the owner, who can read a Postgres error and knows what to do next.

The first paying customer reverses this completely: **they will never notice the prevention, and they will only notice the recovery.**

---

## 3. At a glance

| Area | Health | One line |
|---|---|---|
| **Design-token discipline** | ✅ | Only **12** hardcoded-color occurrences in all of `src/app` (10 of them in the public buy page). §5 is genuinely followed — rare. |
| **Destructive actions** | ✅ | **50** call sites use a proper `useConfirm()` dialog (title / body / danger / custom label). 3 files still on `window.confirm`. |
| **Money formatting** | 🟡 | `rupee()` used **919** times; only **10** locale-less calls exist — but **8 sit in one file** and show the wrong grouping on a customer's machine (G3). |
| **Input defaults / smart pre-fill** | ✅ | Best-in-class on the payment path (auto-locked settlement amount, credit + TDS aware). |
| **Success feedback** | ✅ | Tells the user what is *still due*, not just "saved" (`record-payment-dialog.tsx:492`). |
| **Error recovery** | 🔴 | §24's frontend half is effectively unimplemented — 1 of 278 (G1). |
| **Attention staging on money forms** | 🟡 | 21 controls on the most trust-sensitive action, not ordered by how often each is needed (G2). |
| **Navigation load** | 🟡 | 58 items across 11 sections (G5). |

---

## 4. Findings

| # | Finding | Sev |
|---|---|---|
| **G1** | §24's frontend half missing: errors give no reason, no next step, no button (1 of 278) | **P0** |
| **G3** | `vendor-portal` shows the **wrong number grouping** on non-en-IN browsers | **P0** |
| **G2** | Most trust-sensitive form isn't staged by frequency of use — and mis-entry is a *money* error | **P1** |
| **G5** | 58 nav items / 11 sections — heavy for a first-30-days user | **P1** |
| **G4** | 3 files still on `window.confirm` — last 11% of a finished migration | **P2** |
| **G6** | Emoji used as UI icons, including in a money-dialog label | **P2** |

---

### G1 — Errors dead-end the user · **P0** · 🟡 PARTIALLY FIXED 2026-08-12 (money spine done)

> **⚠️ Correction to this audit's own numbers.** The "278 / 3 / 1" figures below were measured with `--include="*.tsx"` only — they **missed every `.ts` file**, which is where the bulk actually lives (`lib/queries/*` mutation `onError` handlers). Exact counts from `git grep` at the pre-fix commit: **452** `toast.error(` call sites across `.ts` + `.tsx`, of which **208** were the raw-message anti-pattern. The conclusion was right and, if anything, understated; the number was wrong. Method note for next time: `grep -F`, and never a single `--include`.
>
> **What was built.** `lib/errors/toast-error.ts` — `describeError()` (pure, 21 tests) + `toastError()`. The design decision that matters: **it branches on the message TEXT, never on the error code.** Our guards deliberately raise good, actionable copy *with* a technical errcode attached (`raise exception 'quote % has no amount …' using errcode = 'check_violation'`), so a code-based rule would have thrown that copy away. Instead it is allowlist-to-**translate**: 7 patterns of raw database plumbing (unique/FK/not-null violations, RLS, missing relation, network, expired JWT) get replaced with plain English + a "why"; everything else passes through untouched. Tests assert verbatim guard strings survive.
>
> **Migrated so far — 54 sites, chosen by blast radius:** the money-spine query modules (`payments`, `quotes`, `invoices`, `projects`, `bank`, `leads`) plus `quotes/[id]`. Query modules pass no destination (they have no router and don't know where the user is) but every one of the **56** `toastError()` sites now gets reason + why for free. Raw dumps: **208 → 160**.
>
> **Two things found while migrating:**
> - `bank.ts` had hand-rolled logic to dig a message out of non-Error PostgREST objects — exactly what the helper does. That block is now one line.
> - **The blocked-delete path on `quotes/[id]` was bypassing a dialog that already existed.** §24 cites that dialog as its example pattern (it lists the blocking invoice + payments, each with an Open button), yet `handleDelete` toasted a bare reason instead of opening it. Now it opens the dialog. This was a *worse* dead end than the raw dumps, and no grep would have found it — only reading did.
> - `leads.ts` optimistic drag-and-drop rollback now says the card went back, instead of silently snapping to its old column.
>
> **Remaining: 160 raw dumps** across the non-money modules (`payroll`, `tds-receivable`, `my-attendance`, `employee-loans`, contacts/campaigns/import dialogs). They follow the identical mechanical pattern — the three `sed` expressions in the commit handle them. Migrate opportunistically; nothing there touches the money spine.
>
> *Verification: **test-verified** (21 tests incl. verbatim guard strings) + typecheck + 226 green + lint 0 errors. **Not** browser-verified.*
> *Follow-up not done: `Sentry.captureException` on the `translated` branch (unexpected technical errors only, so guards don't spam it) — §11 asks for it; kept out to hold this change to one concern.*

CLAUDE.md §24 is explicit, and it is the project's own rule:

> *"Every block gives three things: **what happened** · **why** · **what to do next**, with a button/link to that place whenever a destination exists."*
> *"**"Done" for any guard/block = reason + next-step hint + (where possible) a button.**"*

Measured reality:

| | Count |
|---|---|
| `toast.error` call sites | **278** |
| …with a `description` (the "why") | **3** |
| …with an `action` button (the "what next") | **1** |

The dominant shape, repeated across money screens:

```tsx
onError: (e) => toast.error((e as Error).message)
// quotes/[id]/page.tsx:161, 190, 204, 220 …
```

That is a raw Postgres / RPC exception rendered to a non-technical user — which also breaks §11 (*"Never throw raw errors to the user. Map to friendly messages."*).

**The irony is that the backend already did its half.** The `SECURITY DEFINER` guards (`0147`, `0174`, `0213`) were deliberately written to phrase the block as a next step — §24 even mandates it. So the *words* are usually right; what's missing is the destination. §24 anticipated exactly this: *"RPC guard messages already state the next step in words — surface them **AND add the button**."*

**And the reference implementation already exists.** `payments/page.tsx:805` is the one call site with the full pattern — the very one §24 cites as its example. It was written, documented, and then never replicated.

**Behavioural cost:** a red line with no exit leaves a non-technical user with two options — click the same button again, or message the owner on WhatsApp. Both are worse than a button.

See **§7** for the fix strategy; 278 sites is a pattern problem, not a checklist.

---

### G3 — `vendor-portal` shows wrong number grouping on a customer's machine · **P0** · ✅ FIXED 2026-08-12

> **Fixed.** All 10 locale-less call sites migrated (grep for `toLocaleString()` in `src` now returns zero code hits):
> - **9 sites → `rupee()`** — 8 in `vendor-portal/page.tsx`, 1 in `add-subscription-dialog.tsx`. The literal `₹` was removed since `rupee()` supplies it; all 9 verified for exactly one ₹ (no doubles, none missing). `rupee()` hand-rolls Indian grouping and **never touches locale at all**, so this is immune to the bug class rather than merely correct today.
> - **1 site → pinned `"en-US"`** — `add-vendor-bill-dialog.tsx:223`. Deliberately NOT `en-IN`: that number is a **foreign** amount (USD/EUR), where Western grouping is correct. Worse than a display bug, it turned out — the string is **persisted as an FX audit note**, so the same bill produced a different note on every machine. Both locales are now pinned, with a comment telling the next reader not to "fix" the en-US one.
> - **🐞 Bonus bug found and fixed in `rupee()` itself** (`lib/utils.ts:66`): amounts from **−100 to −999** rendered as `₹-,500` — a stray comma, because the sign landed inside the grouped integer part leaving `rest` as just `"-"`. Negative rupee values are real: `gstPayable`'s own docstring says *"may be negative (credit)"*. Now grouped on the absolute value with the sign re-attached, and `−0.4` renders `₹0` rather than `₹-0`.
> - **Coverage gap closed:** `rupee()` is the most-used function in the app (900+ call sites) and had **zero tests**. Added 18 in `utils.test.ts` locking lakh/crore grouping, all the negative cases, decimals on both signs, compact L/Cr, and the em-dash null path. Suite 196 → **205 green**; typecheck clean; lint 0 errors.
>
> *Verification: **test-verified** (exact output strings asserted) + all 9 changed lines read for ₹ correctness. **Not** browser-verified — see the audit's basis note.*

`toLocaleString()` **without a locale argument** formats using the *browser's* locale:

| Browser locale | `1560000.toLocaleString()` | What an Indian owner expects |
|---|---|---|
| `en-IN` | `15,60,000` ✅ | ₹15,60,000 |
| `en-US` (Windows default) | `1,560,000` ❌ | — reads as a different number |

There are **10** such calls in the app; **8 are in `app/(app)/vendor-portal/page.tsx`** (the other two: `add-subscription-dialog.tsx`, `add-vendor-bill-dialog.tsx`). Elsewhere the codebase correctly uses `rupee()` / `num()`, which pin `en-IN` (`lib/utils.ts:53`, `:90`).

**Why this is P0 and not polish:** lakh/crore grouping is how the reader parses the magnitude. `₹1,560,000` vs `₹15,60,000` is a misread waiting to happen, on a page about **wholesale rate bids**. And it is **invisible on the developer's machine** if that machine is set to en-IN — it only goes wrong for other people.

**`vendor-portal/page.tsx` (2947 lines) is the outlier file generally** — it also holds **16 of the app's 22** emoji-as-icons and one of the 12 hardcoded colours. It appears to have been built fast and outside the design system. Treat it as a single quarantined cleanup rather than evidence of app-wide drift, which the numbers do not support.

---

### G2 — The most trust-sensitive form isn't staged by frequency · **P1**

`record-payment-dialog.tsx` presents **21 input controls**, only ~3 of them conditional. Among them: primary customer domain, deposit-to account, payment date, **TDS section**, **TDS rate**, **customer TAN**, notes, receipt attachment.

The problem is **not** that it's complex — recording a payment against Indian TDS rules genuinely is. The problem is that what's needed **90% of the time** (amount · method · reference · date) sits at the same visual weight as what's needed **10% of the time** (TAN · TDS section · domain).

**Behavioural consequence:** people **satisfice** — they fill the minimum that lets them proceed and guess at the rest. Here, a guessed TDS field is not cosmetic: `record_payment_with_tds` (`0150`) posts the TDS receivable in the same transaction, so a wrong entry becomes a wrong ledger row.

**Fix direction:** progressive disclosure by frequency — the four common fields always visible; TDS behind the existing "TDS deducted?" toggle (so TAN/section/rate only appear once relevant); attachment and notes collapsed. **No logic change** — the underlying defaults are already excellent and must be preserved.

---

### G5 — 58 nav items across 11 sections · **P1**

`lib/nav.ts` defines **58** `href` entries in **11** sections. Collapsible groups mitigate this, and role filtering (`filterNavForRole`) hides much of it from non-owners — both good.

But the owner — the persona who onboards first and decides whether to pay — sees close to all of it on day one. For a non-technical SMB owner this is a lot of surface to interpret before finding the four screens they actually need in week one (leads → quote → payment → invoice).

**Worth considering:** an "essentials first" default for a new tenant (progressively revealing Accounting / HR / Compliance once used, or after setup completes), rather than presenting the full ERP on day one. Not a bug — a first-run decision, and it interacts with the scope question in `TASKS.md`.

---

### G4 — 3 files still on `window.confirm` · **P2**

`app/(app)/quotes/[id]/page.tsx`, `app/(app)/tasks/page.tsx`, `app/(app)/vendor-portal/page.tsx`. (The occurrence inside `components/providers/confirm-provider.tsx` is the provider's own fallback and is fine.)

**50** call sites already use the proper dialog, so this is the last stretch of a migration that is otherwise done — but one of the three is the **quote detail page**, i.e. a money screen, which is why it is listed rather than ignored.

---

### G6 — Emoji as UI icons · **P2**

**22** occurrences, **16** of them in `vendor-portal`. The rest are one-offs. Notable because one is a **form label on the money dialog**: `label="🌐 Primary Customer Domain"` (`record-payment-dialog.tsx:655`).

The project has `lucide-react` plus an `<Icon>` wrapper and an editorial "paper/ink" aesthetic (§5, §6). Emoji render differently per OS/font, don't inherit token colours, and read as a different visual language.

---

## 5. What is verified strong (so this audit is fair)

- **Design-token discipline is real** — 12 hardcoded-colour occurrences across the entire authenticated app. Most codebases with 110 pages are far worse.
- **`useConfirm()` provider** with title / body / `danger` / custom confirm label, used in **50** places — better destructive-action UX than most commercial SaaS.
- **The payment amount default** (`:237-240`) — auto-locked to `remaining − TDS − credit`, released on manual edit, with a comment explaining the rounding-dispute class it kills. This is the single best piece of interaction design in the codebase.
- **Success messaging is outcome-shaped** — a partial payment reports *what is still due* with a 6-second duration (`:492`, `:502`), not a generic "saved".
- **Money formatting has a real helper** with Indian grouping plus compact Cr/L/K modes (`lib/utils.ts:53-93`), and it is used **919** times.
- **Role-aware navigation + command palette** (`filterNavForRole`) so a sales user isn't shown accounting destinations.
- §20 responsive work and §24's **backend** half are both genuinely implemented — the gaps here are the frontend half of §24 and the staging of one form.

---

## 6. False alarms — measured and dismissed, do not re-flag

Recorded so the next audit doesn't "rediscover" these. All three looked like findings under a quick grep and are not:

| Looks like | Actually |
|---|---|
| "24 native `confirm()` on money screens" | They are the **custom** `confirm({ title, body, danger, confirmLabel })` helper. Only 3 files use `window.confirm`. |
| "147 places bypass the money formatter" | Most `toLocaleString` calls **do** pass `en-IN`. Only **10** are locale-less. |
| "No depreciation / salaries missing from P&L" | Salaries **do** post to the P&L via `expenses` (`0087`, `0099`, `0121`). (Depreciation genuinely is missing — see `ACCOUNTING-AUDIT.md` F3.) |

**Method note:** grep counts on this codebase consistently read worse than reality. Verify the call shape before filing a finding.

---

## 7. Fixing G1 — a pattern, not a checklist

278 call sites cannot be migrated in one pass, and most don't need bespoke copy. Suggested approach:

1. **One shared helper** — e.g. `lib/errors/toast-error.ts`:
   ```ts
   toastError(err, { action?: { label, href } })
   ```
   - Known RPC guard messages already read as next steps → **keep the message**, attach a destination.
   - Unknown / unexpected errors → friendly fallback message + a "Copy details" affordance for support, never the raw string.
2. **Migrate by blast radius, not by file order.** Money and customer-facing first: `quotes/[id]`, `payments`, `invoices`, `accounting/expenses`, `accounting/bills`, then the public buy / portal / quote-accept pages. Everything else can follow opportunistically.
3. **Destinations mostly already exist** — the blocked-delete dialog on quote detail and `payments/page.tsx:805` show the shape; the guard text usually names the place to go ("that invoice", "that bank line"), so the link target is derivable.
4. **Add it to the definition of done.** §24 already says "done = reason + next step + button"; what's missing is a check that enforces it on new code, the same way §25 defines the local test gate.

---

## 8. Recommended order

1. **G3** — smallest fix, wrong numbers, and invisible on your own machine. 10 call sites → `rupee()` / `num()`. Do this first purely on cost/benefit.
2. **G1** — biggest behavioural gap and the one the first paying customer will actually feel. Ship the shared helper + the money screens; let the long tail follow.
3. **G2** — progressive disclosure on the payment dialog. **Preserve the existing defaults exactly** — they are the best thing on the screen.
4. **G4 + G6** — mechanical, bundle them with whatever else touches those files. `vendor-portal` is the natural place to do G3 + G4 + G6 in one pass.
5. **G5** — a first-run product decision, not a fix. Tied to the scope conversation in `TASKS.md`.

**Still outstanding, and not substitutable by this doc:** an actual visual review — hierarchy, contrast, spacing, real mobile feel — plus the `design-critique` and `accessibility-review` skills (§0.9), and WCAG AA verification (§8). Those need a working preview and eyes on the screens.
