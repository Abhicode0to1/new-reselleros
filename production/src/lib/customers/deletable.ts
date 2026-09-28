/**
 * Customer-deletion guard — pure, unit-tested.
 *
 * MONEY-CORRECTNESS + Zoho-Books parity: a customer may be hard-deleted ONLY when it
 * is truly empty. Everything else is a real document.
 *
 * Since R-007 (migration 20260926130000) the DATABASE enforces this too: invoices,
 * quotes, credit notes, debit notes, TDS entries, projects and subscriptions all hold
 * the customer with ON DELETE RESTRICT. Before that, the first six detached
 * (SET NULL, leaving a record with nobody on it) and subscriptions were DESTROYED
 * (CASCADE, erasing recurring revenue and its renewals).
 *
 * So the rule is Zoho's: hard-delete only a mistake, a duplicate or a test record —
 * anything with history is ARCHIVED instead. `delete_customer()` is the authority
 * (0174, extended by R-007); this twin drives the client, explains the block before the
 * round trip, and is unit-tested.
 */
export interface CustomerMoneyCounts {
  subscriptions: number;
  payments: number;
  invoices: number;
  quotes: number;
  projects: number;
  /* OPTIONAL, and the reason is worth knowing. `delete_customer` counts these three
     since R-007, but the customer profile does not load them — there is no
     by-customer query for credit or debit notes, and adding three fetches to explain
     a rare block is not worth the round trips.

     So on a customer holding ONLY one of these, the twin says "deletable", the RPC
     refuses, and its message — which names the record type and points at Archive —
     reaches the operator as the error toast. Less pretty, never wrong. Pass them
     when a caller has them and the dialog gets the nicer wording. */
  creditNotes?: number;
  debitNotes?: number;
  tdsEntries?: number;
}

/** Returns a human reason when the customer is NOT safe to delete, else null. */
export function customerDeleteBlockReason(counts: CustomerMoneyCounts): string | null {
  const parts: string[] = [];
  if (counts.subscriptions > 0) parts.push(`${counts.subscriptions} subscription${counts.subscriptions === 1 ? "" : "s"}`);
  if (counts.payments > 0)      parts.push(`${counts.payments} payment${counts.payments === 1 ? "" : "s"}`);
  if (counts.invoices > 0)      parts.push(`${counts.invoices} invoice${counts.invoices === 1 ? "" : "s"}`);
  if (counts.quotes > 0)        parts.push(`${counts.quotes} quote${counts.quotes === 1 ? "" : "s"}`);
  if (counts.projects > 0)      parts.push(`${counts.projects} project${counts.projects === 1 ? "" : "s"}`);
  if ((counts.creditNotes ?? 0) > 0) parts.push(`${counts.creditNotes} credit note${counts.creditNotes === 1 ? "" : "s"}`);
  if ((counts.debitNotes ?? 0) > 0)  parts.push(`${counts.debitNotes} debit note${counts.debitNotes === 1 ? "" : "s"}`);
  if ((counts.tdsEntries ?? 0) > 0)  parts.push(`${counts.tdsEntries} TDS entr${counts.tdsEntries === 1 ? "y" : "ies"}`);
  if (parts.length === 0) return null;
  return `This customer has ${parts.join(", ")}. A customer can only be deleted when it has no documents — delete those first, or archive the customer instead.`;
}
