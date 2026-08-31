/**
 * QuotePDF — server/browser-renderable PDF version of the quote preview.
 *
 * Mirrors the layout of `quote-preview-dialog.tsx` but in @react-pdf/renderer
 * primitives (Document/Page/View/Text). Used by the "Download PDF" button on
 * the quote detail page and (soon) by the email-send flow that attaches the
 * generated PDF.
 *
 * Layout (A4 portrait):
 *   1. Brand header  — tenant monogram, name, GSTIN, contact / quotation #, dates
 *   2. Bill to       — customer name + contact + place-of-supply + HSN/SAC
 *   3. Line items    — table with qty / rate / amount
 *   4. Totals        — subtotal / discount / GST split / grand total
 *   5. Notes         — optional
 *   6. Terms footer  — payment terms + validity + signoff
 *
 * Money is formatted via `rupee()` so Indian lakh/crore grouping is preserved.
 */
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";
import { rupee, formatDate } from "@/lib/utils";
import { isForeignCurrency, formatForeign } from "@/lib/currency";
import type { QuoteLineItem, LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  cycleInvoicesPerYear, cycleUnitLabel, cycleScheduleLabel, cycleFromLegacyCommitment,
} from "@/lib/quotes/billing";
import { perInvoiceDivisor, annualContractValue } from "./invoice-divisor";

// ─── Billing helpers ───────────────────────────────────────────────────────
// Frequency is a quote-level `billing_cycle` (migration 0161); a line's
// `commitment` is only its PRICE TIER (monthly-flex vs annual).

function scheduleLabel(commitment: LineCommitment | undefined, cycle: BillingCycle): string {
  const tier = commitment === "monthly" ? "Monthly (flex)" : "Annual commit";
  return `${tier}, ${cycleScheduleLabel(cycle)}`;
}

// ─── Props ────────────────────────────────────────────────────────────────

export interface QuotePDFProps {
  // Tenant (supplier)
  tenantName:     string;
  tenantGstin?:   string | null;
  tenantEmail?:   string | null;
  tenantPhone?:   string | null;
  tenantAddress?: string | null;

  // Quote
  quoteId:       string;
  customerName:  string;
  contactName?:  string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  createdDate?:  string | Date | null;
  expiresDate?:  string | Date | null;
  validityDays:  number;
  lineItems:     QuoteLineItem[];
  subtotal:      number;
  discountPct:   number;
  discount:      number;
  taxable:       number;
  taxRate:       number;
  tax:           number;
  total:         number;
  interState:    boolean;
  /** Export supply (recipient outside India) → zero-rated under LUT, no GST. */
  isExport?:     boolean;
  /** Billing currency + rate — foreign → the whole quote shows in that currency. */
  currency?:     string | null;
  exchangeRate?: number | null;
  /** Quote-level invoice frequency (migration 0161); falls back to legacy per-line commitment. */
  billingCycle?: BillingCycle;
  notes?:        string;
  termsConditions?: string | null;
  /** When true, renders "Renewal Quotation" label + visible "RENEWAL" stamp.
   *  Set by lib/renewals/create-renewal-quote.ts on the source quote. */
  isRenewal?:    boolean;
  /** Scan-to-pay QR as a PNG data-URL, from buildQuoteUpiQr(). Null → no block.
   *  The decision of WHETHER to offer a QR belongs to the caller, not here: it
   *  depends on currency and payment status, which this component doesn't see. */
  upiQrDataUrl?: string | null;
  /** Printed under the QR so a payer whose camera struggles can type it. */
  upiVpa?:       string | null;
}

// ─── Styles ───────────────────────────────────────────────────────────────

// @react-pdf/renderer doesn't support Tailwind. We define a tight set of
// reusable styles that map closely to the dialog's visual hierarchy.
const COLORS = {
  ink:    "#1A1A1A",
  ink2:   "#3A3A3A",
  ink3:   "#7A7A7A",
  paper:  "#FFFFFF",
  amber:  "#C2410C",
  hairline: "#E4E4E4",
};

const s = StyleSheet.create({
  page: {
    paddingHorizontal: 40,
    paddingVertical:   36,
    fontFamily:        "Helvetica",
    fontSize:          10,
    color:             COLORS.ink,
    backgroundColor:   COLORS.paper,
  },

  // Header
  header: {
    flexDirection:    "row",
    justifyContent:   "space-between",
    alignItems:       "flex-start",
    borderBottomWidth: 2,
    borderBottomColor: COLORS.ink,
    paddingBottom:    14,
    marginBottom:     18,
  },
  brandBlock: {
    flexDirection: "row",
    alignItems:    "flex-start",
  },
  brandMonogram: {
    width:            36,
    height:           36,
    backgroundColor:  COLORS.ink,
    color:            COLORS.paper,
    fontFamily:       "Helvetica-Bold",
    fontSize:         18,
    textAlign:        "center",
    paddingTop:       7,
    marginRight:      10,
  },
  brandName: {
    fontFamily: "Helvetica-Bold",
    fontSize:   16,
    color:      COLORS.ink,
  },
  brandMeta: {
    fontSize: 9,
    color:    COLORS.ink3,
    marginTop: 2,
  },
  quoteMetaBlock: {
    alignItems: "flex-end",
  },
  quoteLabel: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    "Helvetica-Bold",
    textTransform: "uppercase",
  },
  quoteId: {
    fontFamily: "Helvetica-Bold",
    fontSize:   22,
    color:      COLORS.ink,
    marginTop:  2,
  },
  quoteDate: {
    fontSize:  9,
    color:     COLORS.ink3,
    marginTop: 2,
  },
  renewalStamp: {
    marginTop:       8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: "#FDF6E0",
    color:           "#7C5A00",
    fontSize:        9,
    fontFamily:      "Helvetica-Bold",
    letterSpacing:   2,
    textAlign:       "center",
    alignSelf:       "flex-start",
    borderWidth:     0.5,
    borderColor:     "#C9A95C",
    borderStyle:     "solid",
  },

  // 2-column block
  twoCol: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   18,
  },
  colLeft:  { flex: 1, paddingRight: 12 },
  colRight: { flex: 1, alignItems: "flex-end" },

  sectionLabel: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom:  3,
  },
  customerName: {
    fontFamily: "Helvetica-Bold",
    fontSize:   13,
    color:      COLORS.ink,
  },
  customerLine: {
    fontSize: 10,
    color:    COLORS.ink2,
    marginTop: 2,
  },
  customerMono: {
    fontFamily: "Courier",
    fontSize:   9,
    color:      COLORS.ink3,
    marginTop:  1,
  },
  metaValue: {
    fontSize: 10,
    color:    COLORS.ink,
    marginTop: 1,
  },
  metaValueMono: {
    fontFamily: "Courier",
    fontSize:   10,
  },
  metaGroup: { marginTop: 8 },

  // Line items table
  table: { marginBottom: 14 },
  trHeader: {
    flexDirection:    "row",
    borderTopWidth:   2,
    borderBottomWidth: 2,
    borderColor:      COLORS.ink,
    paddingVertical:  6,
  },
  tr: {
    flexDirection:    "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingVertical:  8,
  },
  thDesc:    { flex: 4, fontFamily: "Helvetica-Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 1 },
  thQty:     { width: 40, fontFamily: "Helvetica-Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  thRate:    { width: 70, fontFamily: "Helvetica-Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  thAmount:  { width: 90, fontFamily: "Helvetica-Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  tdDesc:    { flex: 4 },
  tdQty:     { width: 40, fontSize: 10, textAlign: "right" },
  tdRate:    { width: 70, fontSize: 10, textAlign: "right" },
  tdAmount:  { width: 90, textAlign: "right" },

  lineName: { fontFamily: "Helvetica-Bold", fontSize: 10, color: COLORS.ink },
  lineMeta: { fontSize: 9, color: COLORS.ink3, marginTop: 2 },
  lineAmount: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  lineAmountSub: { fontSize: 8, color: COLORS.ink3, marginTop: 1 },

  emptyRow: {
    paddingVertical: 20,
    textAlign:       "center",
    color:           COLORS.ink3,
    fontSize:        10,
    fontStyle:       "italic",
  },

  // Totals
  totalsWrap: {
    flexDirection:  "row",
    justifyContent: "flex-end",
    marginBottom:   16,
  },
  totalsBox: { width: 250 },
  totalRow: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    paddingVertical: 3,
    fontSize:        10,
  },
  totalLabel: { color: COLORS.ink3 },
  totalValue: { color: COLORS.ink },
  totalValueAccent: { color: "#059669" /* emerald */ },

  grandTotalDivider: {
    borderTopWidth: 2,
    borderTopColor: COLORS.ink,
    marginTop:      6,
    paddingTop:     6,
  },
  grandLabel: {
    fontSize:      9,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontFamily:    "Helvetica-Bold",
  },
  grandValue: {
    fontFamily: "Helvetica-Bold",
    fontSize:   18,
  },
  perInvoiceRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginTop:      4,
    fontSize:       9,
    color:          COLORS.ink3,
  },

  // Notes
  notesBox: {
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop:     10,
    marginBottom:   14,
  },
  notesText: {
    fontSize:   10,
    color:      COLORS.ink2,
    lineHeight: 1.4,
  },

  // Footer
  footer: {
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop:     10,
    marginTop:      16,
  },
  upiRow: {
    flexDirection:  "row",
    alignItems:     "center",
    marginTop:      10,
    paddingTop:     8,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
  },
  upiQr:    { width: 78, height: 78, marginRight: 10 },
  upiText:  { flex: 1 },
  upiTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: COLORS.ink2, marginBottom: 2 },
  upiSub:   { fontSize: 8, color: COLORS.ink3, lineHeight: 1.4 },
  upiVpa:   { fontSize: 9, fontFamily: "Helvetica-Bold", color: COLORS.ink2, marginTop: 2, marginBottom: 2 },
  footerLine: {
    fontSize:   9,
    color:      COLORS.ink3,
    marginBottom: 3,
    lineHeight: 1.4,
  },
  footerBold: {
    fontFamily: "Helvetica-Bold",
    color:      COLORS.ink2,
  },
});

// ─── Document ─────────────────────────────────────────────────────────────

export function QuotePDF(props: QuotePDFProps) {
  const {
    tenantName, tenantGstin, tenantEmail, tenantPhone, tenantAddress,
    quoteId, customerName, contactName, contactEmail, contactPhone,
    createdDate, expiresDate, validityDays,
    lineItems, subtotal, discountPct, discount, taxable, taxRate, tax, total,
    interState, isExport = false, currency, exchangeRate, billingCycle, notes, termsConditions, isRenewal,
    upiQrDataUrl, upiVpa,
  } = props;

  const brandInitial = (tenantName?.trim()?.[0] ?? "?").toUpperCase();
  const created = createdDate ? new Date(createdDate) : new Date();
  const expires = expiresDate
    ? new Date(expiresDate)
    : new Date(Date.now() + validityDays * 86400000);

  // Detect shared billing cycle to render "per invoice" totals if all lines agree
  // Billing frequency is a single quote-level value (0161); legacy fallback.
  const firstCommitment = lineItems[0]?.commitment;
  const effectiveCycle: BillingCycle = billingCycle ?? cycleFromLegacyCommitment(firstCommitment);
  const billingN    = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit = cycleUnitLabel(effectiveCycle);
  const perInvoice  = billingN > 1;
  // Foreign customer → render the quote in their currency (USD…); books stay ₹, so
  // the INR equivalent is printed as a GST reference.
  const isForeign   = isForeignCurrency(currency);
  const fxRate      = exchangeRate ?? 1;

  // Consistent display-currency math: for a foreign quote, work per-unit in the
  // client's currency (₹ ÷ rate, rounded 2dp) so qty × rate == amount and the
  // lines sum to the total (a plain per-figure ₹ ÷ rate makes a rounded unit rate
  // disagree with the exact total, e.g. 32 × $32.00 ≠ $1,023.88). Books stay ₹.
  const dRound = (v: number) => (isForeign ? Math.round(v * 100) / 100 : Math.round(v));
  const toDisp = (inr: number) => (isForeign ? dRound(inr / fxRate) : inr);
  const fmtC   = (v: number) => (isForeign ? formatForeign(v, currency ?? "") : rupee(v));
  /* ── TWO DIFFERENT THINGS BOTH LOOK LIKE "MONTHLY" ────────────────────────
     Everything below used to divide every stored figure by `billingN`, on the assumption
     that a stored figure is always an ANNUAL contract value. That is right for the common
     case — an annual commitment billed in twelve instalments — and wrong for the other one:

       annual_yearly + billing monthly   ->  subtotal is a YEAR.   Divide by 12.
       monthly (flex) + billing monthly  ->  subtotal is a MONTH.  Divide by nothing.

     `lib/quotes/commitment-rate.ts` documents that boundary and three SQL regression tests
     pin it — a monthly line's rate is per seat per MONTH, and `record_payment` divides by
     1.0 rather than 12.0 for exactly that reason. The renderer was the one place that had
     not been told.

     Measured on Q-ADPL-2026-27-0053, sent: 36 seats at Rs 325/seat/month, subtotal
     Rs 11,700/month — printed as "Rs 27/mo · Rs 975/mo · Rs 13,392/yr". A twelfth of the
     real price, on a GST document. The row was correct; only this line was not.

     `billingCycle` alone cannot tell the two apart, because both say "monthly". The LINE's
     own commitment can, and it is the same field the pricing planner set. */
  const invoiceDivisor = perInvoiceDivisor(billingN, firstCommitment);
  const fmtInv = (stored: number) =>
    perInvoice ? `${fmtC(dRound(stored / invoiceDivisor))}${billingUnit}` : fmtC(stored);

  // Totals: for a FOREIGN quote, rebuild from the display-currency lines so the
  // printed lines + totals agree (qty × rate == amount, Σ lines == total). For a
  // domestic ₹ quote, keep the canonical stored figures untouched (no rounding
  // drift vs the saved amount). Discounting is quote-level; per-line is legacy/0.
  const dLineAnnual = lineItems.map((l) => dRound(l.qty * toDisp(l.rate)));
  const dSubtotal = isForeign ? dRound(dLineAnnual.reduce((s, v) => s + v, 0)) : subtotal;
  const dDiscount = isForeign ? dRound(dSubtotal * (discountPct / 100))        : discount;
  const dTaxable  = isForeign ? dRound(dSubtotal - dDiscount)                  : taxable;
  const dTax      = isForeign ? dRound(dTaxable * (taxRate / 100))             : tax;
  const dTotal    = isForeign ? dRound(dTaxable + dTax)                        : total;

  return (
    <Document
      title={`Quote ${quoteId}`}
      author={tenantName}
      subject={`Quotation ${quoteId} for ${customerName}`}
    >
      <Page size="A4" style={s.page}>

        {/* ── Header ──────────────────────────────────────────────── */}
        <View style={s.header}>
          <View style={s.brandBlock}>
            <Text style={s.brandMonogram}>{brandInitial}</Text>
            <View>
              <Text style={s.brandName}>{tenantName}</Text>
              {tenantGstin && (
                <Text style={s.brandMeta}>GSTIN: {tenantGstin}</Text>
              )}
              {tenantAddress && (
                <Text style={s.brandMeta}>{tenantAddress}</Text>
              )}
              {(tenantEmail || tenantPhone) && (
                <Text style={s.brandMeta}>
                  {[tenantEmail, tenantPhone].filter(Boolean).join("  ·  ")}
                </Text>
              )}
            </View>
          </View>
          <View style={s.quoteMetaBlock}>
            <Text style={s.quoteLabel}>{isRenewal ? "Renewal Quotation" : "Quotation"}</Text>
            <Text style={s.quoteId}>{quoteId}</Text>
            <Text style={s.quoteDate}>Dated: {formatDate(created)}</Text>
            <Text style={s.quoteDate}>Valid until: {formatDate(expires)}</Text>
            {isRenewal && (
              <Text style={s.renewalStamp}>RENEWAL</Text>
            )}
          </View>
        </View>

        {/* ── Bill to + Meta ──────────────────────────────────────── */}
        <View style={s.twoCol}>
          <View style={s.colLeft}>
            <Text style={s.sectionLabel}>Bill to</Text>
            <Text style={s.customerName}>{customerName}</Text>
            {contactName && (
              <Text style={s.customerLine}>Attn: {contactName}</Text>
            )}
            {contactEmail && (
              <Text style={s.customerMono}>{contactEmail}</Text>
            )}
            {contactPhone && (
              <Text style={s.customerMono}>{contactPhone}</Text>
            )}
          </View>
          <View style={s.colRight}>
            <Text style={s.sectionLabel}>Place of supply</Text>
            <Text style={s.metaValue}>
              {isExport
                ? "Export · zero-rated under LUT (no GST)"
                : interState ? "Inter-state (IGST applies)" : "Intra-state (CGST + SGST)"}
            </Text>
            {lineItems.length > 0 && firstCommitment && (
              <View style={s.metaGroup}>
                <Text style={s.sectionLabel}>Billing schedule</Text>
                <Text style={s.metaValue}>{scheduleLabel(firstCommitment, effectiveCycle)}</Text>
                {billingN > 1 && (
                  <Text style={[s.metaValue, { fontSize: 9, color: COLORS.ink3 }]}>
                    {billingN} invoices per year
                  </Text>
                )}
              </View>
            )}
            <View style={s.metaGroup}>
              <Text style={s.sectionLabel}>HSN / SAC</Text>
              <Text style={[s.metaValue, s.metaValueMono]}>998313</Text>
            </View>
          </View>
        </View>

        {/* ── Line items ──────────────────────────────────────────── */}
        <View style={s.table}>
          <View style={s.trHeader}>
            <Text style={s.thDesc}>Description</Text>
            <Text style={s.thQty}>Qty</Text>
            <Text style={s.thRate}>Rate</Text>
            <Text style={s.thAmount}>Amount</Text>
          </View>

          {lineItems.length === 0 ? (
            <Text style={s.emptyRow}>No line items.</Text>
          ) : (
            lineItems.map((line) => {
              // Per-unit in the DISPLAY currency so qty × rate == amount exactly.
              const lineDiscountPct = line.discount_pct ?? 0;   // quote-level discounting; per-line is legacy/0
              const unit        = toDisp(line.rate);            // per seat / year
              const grossAnnual = dRound(line.qty * unit);
              const netAnnual   = dRound(grossAnnual * (1 - lineDiscountPct / 100));
              return (
                <View key={line.id} style={s.tr} wrap={false}>
                  <View style={s.tdDesc}>
                    <Text style={s.lineName}>{line.name}</Text>
                    <Text style={s.lineMeta}>
                      Per seat{perInvoice ? "" : " per year"} · HSN 998313
                      {line.commitment && ` · ${scheduleLabel(line.commitment, effectiveCycle)}`}
                    </Text>
                    {lineDiscountPct > 0 && (
                      <Text style={s.lineMeta}>
                        Discount: {lineDiscountPct}%
                        {line.discount_reason ? ` (${line.discount_reason})` : ""}
                      </Text>
                    )}
                    {line.bulk && line.domains && line.domains.length > 0 && (
                      <Text style={s.lineMeta}>
                        Covering {line.domains.length} domains: {line.domains.map((d) => `${d.domain} (${d.seats})`).join(", ")}
                      </Text>
                    )}
                  </View>
                  <Text style={s.tdQty}>{line.qty}</Text>
                  <Text style={s.tdRate}>{fmtInv(unit)}</Text>
                  <View style={s.tdAmount}>
                    <Text style={s.lineAmount}>{fmtInv(netAnnual)}</Text>
                    {perInvoice && (
                      <Text style={s.lineAmountSub}>
                        = {fmtC(netAnnual)}/yr
                        {lineDiscountPct > 0 ? ` (was ${fmtC(grossAnnual)})` : ""}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>

        {/* ── Totals ──────────────────────────────────────────────── */}
        {lineItems.length > 0 && (
          <View style={s.totalsWrap}>
            <View style={s.totalsBox}>
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>
                  {perInvoice ? "Subtotal (per invoice)" : "Subtotal"}
                </Text>
                <Text style={s.totalValue}>{fmtInv(dSubtotal)}</Text>
              </View>
              {discountPct > 0 && (
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>Discount ({discountPct}%)</Text>
                  <Text style={s.totalValueAccent}>-{fmtInv(dDiscount)}</Text>
                </View>
              )}
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Taxable amount</Text>
                <Text style={s.totalValue}>{fmtInv(dTaxable)}</Text>
              </View>
              {isExport ? (
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>Export — zero-rated (LUT), no GST</Text>
                  <Text style={s.totalValue}>{fmtC(0)}</Text>
                </View>
              ) : interState ? (
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>IGST ({taxRate}%)</Text>
                  <Text style={s.totalValue}>{fmtInv(dTax)}</Text>
                </View>
              ) : (
                <>
                  <View style={s.totalRow}>
                    <Text style={s.totalLabel}>CGST ({taxRate / 2}%)</Text>
                    <Text style={s.totalValue}>{fmtInv(dRound(dTax / 2))}</Text>
                  </View>
                  <View style={s.totalRow}>
                    <Text style={s.totalLabel}>SGST ({taxRate / 2}%)</Text>
                    <Text style={s.totalValue}>{fmtInv(dRound(dTax - dRound(dTax / 2)))}</Text>
                  </View>
                </>
              )}
              <View style={s.grandTotalDivider}>
                <View style={s.totalRow}>
                  <Text style={s.grandLabel}>
                    {perInvoice ? `Per invoice (${billingN}/yr)` : "Grand total"}
                  </Text>
                  <Text style={s.grandValue}>
                    {perInvoice
                      ? `${fmtC(dRound(dTotal / invoiceDivisor))}${billingUnit}`
                      : fmtC(dTotal)}
                  </Text>
                </View>
                {perInvoice && (
                  <View style={s.perInvoiceRow}>
                    <Text>Annual contract value</Text>
                    {/* The mirror of the divisor above. On an annual commitment billed
                        monthly, `dTotal` IS the year. On a monthly-flex line it is ONE
                        MONTH, so the year is twelve of them — printing `dTotal` there
                        published a contract value a twelfth of the truth, next to a
                        correct per-month figure. */}
                    <Text>{fmtC(annualContractValue(dTotal, billingN, firstCommitment))}/yr</Text>
                  </View>
                )}
                {isForeign && (
                  <View style={s.perInvoiceRow}>
                    <Text>INR equivalent (for GST) @ Rs {exchangeRate}/{currency}</Text>
                    <Text>{rupee(total)}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        )}

        {/* ── Notes ───────────────────────────────────────────────── */}
        {notes && notes.trim().length > 0 && (
          <View style={s.notesBox}>
            <Text style={s.sectionLabel}>Notes</Text>
            <Text style={[s.notesText, { marginTop: 4 }]}>{notes}</Text>
          </View>
        )}

        {/* ── Terms & conditions ──────────────────────────────────── */}
        {termsConditions && termsConditions.trim().length > 0 && (
          <View style={s.notesBox}>
            <Text style={s.sectionLabel}>Terms &amp; conditions</Text>
            <Text style={[s.notesText, { marginTop: 4 }]}>{termsConditions.trim()}</Text>
          </View>
        )}

        {/* ── Terms footer ────────────────────────────────────────── */}
        <View style={s.footer}>
          <Text style={s.footerLine}>
            <Text style={s.footerBold}>Payment terms: </Text>
            Net 7 days from acceptance. UPI / NEFT / Razorpay accepted.
          </Text>
          <Text style={s.footerLine}>
            <Text style={s.footerBold}>Quote validity: </Text>
            {validityDays} days from issue date.
          </Text>

          {/* Scan-to-pay. Drawn only when the caller supplied a QR — which it
              does only for an INR quote that is still awaiting payment. The
              wording says ADVANCE deliberately: money paid against a quote
              arrives before the tax invoice exists, so it is an advance and the
              seller answers it with a Receipt Voucher under CGST §31(3)(d).
              Calling it a payment here would set up the wrong expectation about
              which document the customer gets back. */}
          {upiQrDataUrl ? (
            <View style={s.upiRow}>
              <Image src={upiQrDataUrl} style={s.upiQr} />
              <View style={s.upiText}>
                <Text style={s.upiTitle}>Scan to pay this advance</Text>
                <Text style={s.upiSub}>
                  Any UPI app — GPay, PhonePe, Paytm, BHIM.
                </Text>
                {upiVpa ? <Text style={s.upiVpa}>{upiVpa}</Text> : null}
                <Text style={s.upiSub}>
                  Amount and quote number are pre-filled. You&apos;ll receive a receipt
                  voucher, and a GST tax invoice when the order is provisioned.
                </Text>
              </View>
            </View>
          ) : null}
          <Text style={[s.footerLine, { marginTop: 4 }]}>
            Thank you for considering {tenantName}.
            {tenantEmail && ` Reach out at ${tenantEmail} for any clarifications.`}
          </Text>
        </View>
      </Page>
    </Document>
  );
}
