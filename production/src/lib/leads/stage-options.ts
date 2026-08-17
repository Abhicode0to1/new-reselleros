/**
 * Which stages a lead's inline dropdown may offer.
 *
 * ─── THE BUG THIS EXISTS TO KILL ────────────────────────────────────────────
 * The options used to be chosen by which PAGE you were on: /leads offered
 * new/contact/lost, /deals offered quote/demo/trial/won/lost. That was coherent while the
 * two pages held two halves of the pipeline. After the merge every open lead lives on one
 * page — so a `won` deal was rendered inside a `<select>` whose options were
 * new / contact / lost.
 *
 * A browser does not leave such a select blank. It shows the FIRST option. So both of this
 * tenant's won deals displayed the word **New**, in the Stage column, next to ₹4,39,994
 * that had already been collected. Verified in the browser, not deduced.
 *
 * Two harms, and the second is the expensive one:
 *   1. The screen states something false, confidently.
 *   2. The control is live. One careless click on that dropdown writes `new` over `won` —
 *      a deal with a payment, an invoice and a subscription behind it, silently demoted
 *      to an untouched enquiry.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * Options are a function of the LEAD, never of the page, and the lead's own stage is
 * always among them. That invariant is what makes "displays the truth" structural rather
 * than a thing to remember.
 *
 * ─── THE QUOTE-FIRST GATE IS KEPT ───────────────────────────────────────────
 * A pre-quote lead is NOT offered demo / trial / quote. Sending a quote is the one gate
 * out of the inbox (quote-builder.tsx sets `quote` itself), and a dropdown that skips it
 * would produce deals at `trial` with no quotation behind them — nothing to invoice
 * against and nothing the customer ever agreed to.
 *
 * ─── WON IS NOT AN INLINE EDIT ──────────────────────────────────────────────
 * `won` returns itself alone, so the caller renders a static badge instead of a control.
 * Un-winning a deal means money already recorded against it; that belongs in a deliberate
 * action with a confirmation, not in a table cell one row away from the scrollbar.
 *
 * ─── LOST CAN COME BACK ─────────────────────────────────────────────────────
 * `lost` offers new and contact. Deals are marked lost by mistake, and customers return
 * months later. Without a way back the only route is a duplicate record — which splits
 * the history of one relationship across two rows.
 */
import type { Lead } from "@/lib/supabase/database.types";

export type Stage = Lead["stage"];

const PRE_QUOTE: readonly Stage[] = ["new", "contact", "lost"];
const POST_QUOTE: readonly Stage[] = ["quote", "demo", "trial", "won", "lost"];
const REVIVE: readonly Stage[] = ["lost", "new", "contact"];

/**
 * The stages this lead's inline dropdown may show, current stage always included.
 *
 * A single-element result means "no inline change" — render the stage, not a control.
 */
export function rowStageOptions(stage: Stage): readonly Stage[] {
  switch (stage) {
    case "won":
      return ["won"];
    case "lost":
      return REVIVE;
    case "new":
    case "contact":
      return PRE_QUOTE;
    case "quote":
    case "demo":
    case "trial":
      return POST_QUOTE;
  }
}

/** True when the stage should render as text rather than a dropdown. */
export function isStageLocked(stage: Stage): boolean {
  return rowStageOptions(stage).length <= 1;
}
