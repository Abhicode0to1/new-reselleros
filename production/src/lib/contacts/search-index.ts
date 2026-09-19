/**
 * Find a customer by the PERSON you deal with, not by the company name.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Abhishek, 18 Sep 2026: "what if i have to filter customer and subscription who
 * attached with single contact".
 *
 * It is the natural question the moment one person can serve several customers
 * (migration 20260918090000). You do not remember that Anjali looks after Doodh Sang AND
 * FF Impex — you remember Anjali. Before this, the Customers search matched the legacy
 * `customers.contact_name` / `contact_email` columns, which hold only a customer's FIRST
 * contact, so searching her name found one of the two and silently missed the other.
 * The Subscriptions search did not look at contacts at all.
 *
 * ─── WHY AN INDEX AND NOT A QUERY PER SEARCH ────────────────────────────────
 * Both pages already hold their whole list in memory and filter it as you type. Going to
 * the database on every keystroke would make the one filter that is meant to feel
 * instant the only one that stutters. The links are small — one row per person per
 * customer — so they are fetched once and matched locally, exactly like the rest of the
 * search predicate.
 *
 * ─── WHAT COUNTS AS A MATCH ─────────────────────────────────────────────────
 * Name, email and phone. Email because it is what you paste out of a thread, and phone
 * because a number is often the only thing in front of you when a customer calls. All
 * lower-cased and joined into one haystack per customer, so the caller does a single
 * `includes` — the same shape as every other clause in those predicates.
 */

/** One `customer_contacts` row with its person embedded — what PostgREST returns. */
export interface ContactLinkRow {
  customer_id: string;
  contact_id?: string | null;
  contacts: {
    id?: string | null;
    full_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export interface ContactSearchIndex {
  /**
   * customer id → every searchable word of every person on that customer, lower-cased.
   * Absent when a customer has no contacts, so `get()` returning undefined is the
   * honest answer rather than an empty string that quietly matches "".
   */
  textByCustomer: Map<string, string>;
  /** contact id → how many customers they serve. Drives the "Serves 3 customers" chip. */
  customerCountByContact: Map<string, number>;
  /** contact id → the customer ids they serve, for the chip's click-through. */
  customerIdsByContact: Map<string, string[]>;
}

export function buildContactSearchIndex(
  rows: readonly ContactLinkRow[],
): ContactSearchIndex {
  const textByCustomer = new Map<string, string>();
  const customerIdsByContact = new Map<string, string[]>();

  for (const row of rows) {
    if (!row.customer_id) continue;

    const person = row.contacts;
    const words = [person?.full_name, person?.email, person?.phone]
      .map((v) => (v ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (words) {
      const prev = textByCustomer.get(row.customer_id);
      textByCustomer.set(row.customer_id, prev ? `${prev} ${words}` : words);
    }

    const contactId = row.contact_id ?? person?.id ?? null;
    if (contactId) {
      const seen = customerIdsByContact.get(contactId) ?? [];
      /* A person is linked to a customer at most once (customer_contacts_unique_pair),
         but the guard costs nothing and keeps the count honest if that ever changes. */
      if (!seen.includes(row.customer_id)) {
        customerIdsByContact.set(contactId, [...seen, row.customer_id]);
      }
    }
  }

  const customerCountByContact = new Map<string, number>();
  for (const [contactId, ids] of customerIdsByContact) {
    customerCountByContact.set(contactId, ids.length);
  }

  return { textByCustomer, customerCountByContact, customerIdsByContact };
}

/**
 * Does any person on this customer match what was typed?
 *
 * The query is expected already trimmed and lower-cased by the caller, because the
 * caller does that once per keystroke and this runs once per ROW.
 */
export function customerMatchesContact(
  index: ContactSearchIndex, customerId: string, lowerQuery: string,
): boolean {
  if (!lowerQuery) return false;
  return index.textByCustomer.get(customerId)?.includes(lowerQuery) ?? false;
}
