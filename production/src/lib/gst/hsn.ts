/**
 * The HSN/SAC code that goes on a line of this business's invoices.
 *
 * ─── WHY THIS IS A CONSTANT AND NOT A COLUMN ────────────────────────────────
 * Every SKU this product sells — Google Workspace, Microsoft 365, Zoho — is the same
 * thing to a tax officer: an online information and database access or retrieval service,
 * SAC 998313, taxed at 18%. There is no per-item variation to store, and adding an `hsn`
 * column to `items` would create one place for the value to be wrong per SKU while
 * changing nothing about the invoice.
 *
 * ─── AND IT USED TO BE WRITTEN OUT BY HAND IN THREE PLACES ──────────────────
 * `998313` appeared as a bare literal in the invoice table, the GST return page and half
 * a dozen marketing pages. Three copies of a compliance value is two too many: the day
 * this business starts selling something under a different SAC — hardware, or a service
 * that is not SaaS — somebody has to find all of them, and the marketing pages will
 * quietly keep claiming the old one.
 *
 * ─── WHAT THE FORM DOES WITH IT ─────────────────────────────────────────────
 * Shows it. That is the whole feature. The operator never types an HSN and never could
 * get it wrong, but they also never SAW what was about to be printed on a document their
 * customer's accountant will read. A smart default that is invisible is indistinguishable
 * from a missing one.
 */

/** SAC 998313 — online information and database access or retrieval services. */
export const SAAS_HSN = "998313";

/** What that code means, in the words a rep can repeat to a customer who asks. */
export const SAAS_HSN_LABEL = "Online information & database access services";

/** The standard rate on this SAC. */
export const SAAS_GST_RATE = 18;

/**
 * The line a form shows beside a catalogue item.
 *
 * States the tax HEAD as well as the rate, because that is the part that changes with the
 * customer's state and the part that is wrong on an invoice nobody can reconcile: the
 * total is 18% either way, and a wrong head only surfaces at GSTR-1 filing, as the
 * customer's credit failing to match.
 */
export function hsnSummary(interState: boolean | null | undefined): string {
  const head = interState == null
    /* Unknown, and said so. Guessing "CGST + SGST" is what put the wrong head on
       invoices before lib/gst/gstin-state.ts started refusing to infer one. */
    ? "GST head decided by the customer's state"
    : interState
      ? `IGST ${SAAS_GST_RATE}%`
      : `CGST ${SAAS_GST_RATE / 2}% + SGST ${SAAS_GST_RATE / 2}%`;
  return `HSN/SAC ${SAAS_HSN} · ${head}`;
}
