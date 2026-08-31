/**
 * Has this quote actually REACHED the customer?
 *
 * ─── THE MAIL THAT MADE THIS A RULE ─────────────────────────────────────────
 * 31 Aug 2026. An enquiry gave a seat count and a product but never said monthly or annual,
 * so the app drafted Q-ADPL-2026-27-0055 on the assumed annual term and — correctly — refused
 * to send it: monthly and annual differ by twelve, and a price the app inferred and posted is
 * one the customer can hold us to.
 *
 * The agent then wrote to the customer:
 *
 *     "Quotation Q-ADPL-2026-27-0055 has been prepared for 32 seats of Google Workspace
 *      Business Starter."
 *
 * followed by BOTH prices and "confirm which you prefer and I will send over the formal
 * quotation". So the customer was handed the reference number of a document they had never
 * seen, at a price the app had just declined to state, while the draft itself carried only
 * the annual figure.
 *
 * `unbackedQuoteClaim` was working as written: it licenses the claim when a quote exists, and
 * one did. The fault was the fact it was given. "A quote row exists" and "the customer has
 * the quotation" are different statements, and only the second one licenses a reference
 * number in an email.
 *
 * ─── WHY NOT JUST "status = sent" ───────────────────────────────────────────
 * Because a quote moves on from `sent`. `accepted` and `rejected` both mean the customer
 * read it — indeed they mean they acted on it — so a reply that names the reference is
 * perfectly true there. Only `draft` means it never left the building.
 *
 * Pardeep's decision, 31 Aug 2026, asked with the alternative on the table: the agent may
 * name a quotation's number only once the document has been sent.
 */

/**
 * Statuses that mean the customer has the document.
 *
 * Listed rather than expressed as "not draft" on purpose: a status added later — `expired`,
 * `superseded` — should have to be considered, not silently inherit "the customer has it".
 */
export const DELIVERED_QUOTE_STATUSES: readonly string[] = ["sent", "accepted", "rejected"];

/**
 * True when this quote has reached the customer and may be referred to by number.
 *
 * Unknown or missing status is treated as NOT delivered. The cost of the two mistakes is not
 * symmetric: staying quiet about a real quotation is a slightly thinner email, while naming
 * one the customer never received is the failure this file exists to stop.
 */
export function quoteWasDelivered(status: string | null | undefined): boolean {
  if (!status) return false;
  return DELIVERED_QUOTE_STATUSES.includes(status.trim().toLowerCase());
}
