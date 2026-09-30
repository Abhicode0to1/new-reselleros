/**
 * The HSN/SAC code that goes on a line of this business's invoices.
 *
 * ─── WHY THIS IS A CONSTANT AND NOT A COLUMN ────────────────────────────────
 * Every SKU this product sells — Google Workspace, Microsoft 365, Zoho — is the same
 * thing on this invoice: SAC 998313, taxed at 18%. (See "WHAT 998313 ACTUALLY MEANS" below:
 * the old wording here called it an online-information service, which it is not.) There is no per-item variation to store, and adding an `hsn`
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

/*
 * ─── WHAT 998313 ACTUALLY MEANS (WC-gst, 30 Sep 2026) ───────────────────────
 * In the SAC scheme (Notification 11/2017-CT(Rate), annexure) 998313 is
 * "Information technology (IT) consulting and support services". The label below used to
 * say "Online information & database access services": that is the OIDAR idea, which sits
 * under heading 9984, not 998313. The label goes into GSTR-1 Table 12 "Description", so it
 * must be the code's real description. The LABEL is fixed here.
 *
 * The CODE is deliberately NOT changed. Reselling a cloud-software licence / subscription
 * (Google Workspace, Microsoft 365, Zoho) is more commonly classified as:
 *   · 997331 — Licensing services for the right to use computer software and databases
 *   · 998315 — Hosting and IT infrastructure provisioning services
 * All are 18%, so the tax does not change. But the code on invoices already issued and
 * filed cannot be rewritten by a deploy, and switching mid-year splits the HSN table across
 * two codes. That is a CA's call, made once and applied from a date; until then SAAS_HSN
 * stays 998313 and SAC_REVIEW records the open question.
 */

/** SAC 998313 — Information technology (IT) consulting and support services. */
export const SAAS_HSN = "998313";

/** What that code means: the SAC scheme's own description (GSTR-1 Table 12 "Description"). */
export const SAAS_HSN_LABEL = "Information technology (IT) consulting and support services";

/** Open classification question for the CA. Kept beside the code so whoever changes
 *  SAAS_HSN reads it first. Do not change SAAS_HSN without that sign-off. */
export const SAC_REVIEW = {
  current: "998313",
  alternatives: {
    "997331": "Licensing services for the right to use computer software and databases",
    "998315": "Hosting and information technology (IT) infrastructure provisioning services",
  },
  note: "Cloud-software licence resale is more commonly 997331 (or 998315 for hosting). Same 18% rate. Existing invoices keep 998313; any switch needs CA confirmation and an effective date.",
} as const;

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
