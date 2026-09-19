/**
 * The contacts ADDRESS BOOK is retired — one message, one place.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * `contacts` used to be two things at once: an address book of people who were not
 * customers (filled by Google Contacts sync and CSV import, with a "promote to lead"
 * button), and — on paper — a customer's contact people, which nothing ever used.
 *
 * Abhishek's decision, 10 Sep 2026: `contacts` becomes ONLY a customer's people, and
 * anybody who is not a customer yet is a LEAD, which already has a pipeline, an owner,
 * a stage and a follow-up date. He was offered the alternative — repoint the importers
 * at `leads` — and chose to turn them off instead.
 *
 * ─── WHY RETIRED AND NOT DELETED ────────────────────────────────────────────
 * The importers are ~1,600 lines spread across a settings panel, a cron, two
 * integration routes, a page and a dialog, and the cron is wired into cron-report.
 * Deleting all of that in one pass risks breaking screens that have nothing to do with
 * contacts. Failing CLOSED at each entry point stops any new address-book row from
 * being written today — which is the actual goal — and leaves the removal as a tidy-up
 * that can be done safely later, or reversed by deleting this guard.
 *
 * ─── WHY 410 AND NOT 404 ────────────────────────────────────────────────────
 * 404 says "there was never anything here", which would send the next person hunting
 * for a routing bug. 410 Gone says the endpoint existed and was withdrawn on purpose,
 * and the body says where the feature went (§24: never a dead end).
 */
import { NextResponse } from "next/server";

/**
 * The switch. Typed as `boolean`, NOT `true`, on purpose.
 *
 * With a literal `true` TypeScript proves the code after `if (FLAG) return …`
 * unreachable, and inside unreachable code it stops applying the narrowing that the
 * old handler bodies depend on — so four routes lit up with "possibly null" errors on
 * lines that had been fine for months. A `boolean` keeps the retired implementations
 * type-checking exactly as before, which is what makes this guard reversible: delete
 * the two lines at the top of each handler and the feature is back.
 */
export const CONTACT_IMPORT_RETIRED: boolean = true;

export const CONTACT_IMPORT_RETIRED_MESSAGE =
  "Contact importing was retired on 10 Sep 2026. A customer's people are managed on "
  + "the customer's own page (Billing & Subscriptions → Customers), and anybody who is "
  + "not a customer yet belongs in Sales & Pipeline as a lead.";

/** The response every retired address-book entry point returns. */
export function contactImportRetired() {
  return NextResponse.json(
    {
      error: "contact_import_retired",
      message: CONTACT_IMPORT_RETIRED_MESSAGE,
      /* Where to go instead — the endpoint should not make the caller guess. */
      use_instead: {
        customer_contacts: "/customers/[id]",
        prospects: "/leads",
      },
    },
    { status: 410 },
  );
}
