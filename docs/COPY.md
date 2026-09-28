# Copy rule — which words are English, which may be Hinglish

> S36, 28 Sep 2026. Decision owner: Pardeep. Applies to every screen, every owner.
> Background: CLAUDE.md §2 / §13 — the UI is English + Hinglish **by decision**; Hindi
> (Devanagari) and i18n were cancelled on 1 Sep 2026. Do not re-propose either.

## The rule

| What | Language | Why |
|---|---|---|
| **Labels** — form field labels, column headers, tab names, nav rows | **English** | They are scanned, not read. The same word must mean the same thing on every screen, and in the invoice PDF, and to the CA. |
| **Buttons and menu actions** | **English** | A button is a promise of what happens. "Save", "Send quote", "Mark paid" — one verb, one meaning, everywhere. |
| **Headings and dialog titles** | **English** | Same reason as labels; they are also what a screen reader announces first. |
| **Help text, hints, empty states, explanations, warnings** | **Hinglish is fine** | This is where the app *talks* to a non-technical owner. "Khaali chhodo to default lagega" lands better than a formal sentence. |
| **Error messages** | Either — but say what to do next (CLAUDE.md §24) | The sentence must end in an action the reader can take. |
| **Anything a customer sees** (quote, invoice, email, public page) | **English** | It goes to a third party. |

**One screen never flips mid-sentence.** A single sentence is all-English or all-Hinglish.
Two different sentences on one screen may differ (an English label above a Hinglish hint is
the intended pattern); one sentence that starts in one and ends in the other is not.

Roman script only. No Devanagari inside a Hinglish sentence.

## Examples from the code (28 Sep 2026)

| | Before | After |
|---|---|---|
| Button | `Opt-out mein daalo` (marketing/whatsapp) | `Add to opt-out list` |
| Label | `Mahina` (accounting/close) | `Month` |
| Label | `Bank statement ka closing balance (optional)` (accounting/banking/brs) | `Closing balance per bank statement (optional)` |
| Hint — fine as is | `Khaali chhodo to "…" lagega.` (marketing) | — |
| Hint — fine as is | `Sirf owner badal sakta hai` (accounting) | — |
| Explanation — fine as is | `Interest apne-aap estimate kiya (…%/yr par). Bank statement se sahi figure daal do.` (accounting/loans) | — |

The three "before → after" rows were changed in S36 as the worked examples. The rest of the
existing Hinglish labels/buttons were **not** swept: that is a screen-by-screen call per owner,
so a label and the help text under it change together and do not end up flipping.

## For whoever writes the next screen

1. Write the label, button and heading in English first.
2. Then decide whether the help text reads better in Hinglish. Either is fine.
3. Read each sentence on its own: does it switch language halfway? Split it or pick one.
4. A label needs `htmlFor` → the control's `id` (or the control needs `aria-label`) —
   `node production/scripts/a11y-count.mjs --owner <you>` lists every miss.

## Not done in S36

- **No shared strings module.** Pardeep's areas' labels are one-off strings written inline
  across 120+ files; pulling them into one module is a rewrite of every screen, not a
  mechanical change. Revisit only if a second language ever comes back (it is cancelled).
