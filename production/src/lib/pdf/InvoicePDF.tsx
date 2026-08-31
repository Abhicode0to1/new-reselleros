/**
 * InvoicePDF — GST Tax Invoice (CGST Section 31 + Rule 53).
 *
 * Mirrors TaxInvoiceDialog. Differences from QuotePDF:
 *   • Title is "Tax Invoice"; original-for-recipient ribbon
 *   • IRN row (when populated)
 *   • Supplier ↔ Recipient block with GSTIN + state on both sides
 *   • 4-col meta row: Invoice No / Date / Due Date / Place of supply
 *   • Line items table includes HSN/SAC column (mandated by GST rules)
 *   • Advance adjustment section (only when adjusted_advances has rows)
 *   • Net payable line at the bottom of totals
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
import { isRenderableLogo } from "./logo";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import type {
  Invoice,
  QuoteLineItem,
  InvoiceAdvanceAdjustment,
} from "@/lib/supabase/database.types";

// ─── Props ────────────────────────────────────────────────────────────────

export interface InvoicePDFProps {
  invoice:      Invoice;

  // Quote-derived data (re-passes for breakdown — same shape TaxInvoiceDialog uses)
  lineItems:    QuoteLineItem[];
  subtotal:     number;
  discountPct:  number;
  discount:     number;
  taxable:      number;
  taxRate:      number;
  tax:          number;
  total:        number;
  interState?:  boolean;

  // Customer
  customerGstin?:   string | null;
  customerEmail?:   string | null;
  customerAddress?: string | null;
  customerState?:   string | null;
  customerCountry?: string | null;   // foreign → export (zero-rated under LUT)
  currency?:        string | null;   // billing currency (books stay ₹)
  exchangeRate?:    number | null;   // INR per unit of currency
  termsConditions?: string | null;   // document-level T&C (migration 0162)

  // Tenant (supplier)
  tenantName:    string;
  tenantGstin?:  string | null;
  tenantEmail?:  string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;
  tenantState?:   string | null;
  /**
   * The company logo as a resolved `data:image/...` URI, from `logoDataUri()`.
   *
   * Never a URL — see the header of lib/pdf/logo.ts. `isRenderableLogo` refuses anything
   * else, so a caller that passes the stored URL gets a document with no logo rather than a
   * render-time network fetch.
   */
  tenantLogo?:    string | null;

  /**
   * Scan-to-pay QR (migration 0227). PNG data-URL built server-side by
   * lib/pdf/upi-qr.ts — the PDF component stays synchronous. Absent when the
   * tenant hasn't set a UPI ID, and the block simply isn't drawn.
   */
  upiQrDataUrl?: string | null;
  /** Printed under the QR so a payer whose camera struggles can type it. */
  upiVpa?:       string | null;
}

// ─── Styles (shared shape with QuotePDF) ──────────────────────────────────

const COLORS = {
  ink:    "#1A1A1A",
  ink2:   "#3A3A3A",
  ink3:   "#7A7A7A",
  paper:  "#FFFFFF",
  amber:  "#C2410C",
  hairline: "#E4E4E4",
  emerald: "#059669",
  emeraldSoft: "#ECFDF5",
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

  // Title bar
  titleBar: { textAlign: "center", marginBottom: 14 },
  brandLogo: {
    /* Centred above the title, letterhead-style. Height fixed, width free, so a wide
       wordmark stays wide. The party blocks below carry the legal supplier identity — the
       logo is decoration and must never displace them. */
    height:       32,
    maxWidth:     170,
    objectFit:    "contain",
    alignSelf:    "center",
    marginBottom: 8,
  },
  titleEyebrow: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    "Helvetica-Bold",
    textTransform: "uppercase",
  },
  titleMain: {
    fontFamily: "Helvetica-Bold",
    fontSize:   22,
    marginTop:  2,
  },
  titleId: {
    fontFamily: "Courier",
    fontSize:   11,
    color:      COLORS.ink2,
    marginTop:  2,
  },
  titleIrn: {
    fontFamily: "Courier",
    fontSize:   9,
    color:      COLORS.ink3,
    marginTop:  1,
  },

  // Supplier / recipient block
  partiesBlock: {
    flexDirection:   "row",
    borderTopWidth:  2,
    borderBottomWidth: 2,
    borderColor:     COLORS.ink,
    paddingVertical: 12,
    marginBottom:    14,
  },
  party:   { flex: 1, paddingHorizontal: 4 },
  partyR:  { flex: 1, paddingHorizontal: 4, alignItems: "flex-end" },
  partyLabel: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom:  4,
  },
  partyName: {
    fontFamily: "Helvetica-Bold",
    fontSize:   13,
    color:      COLORS.ink,
  },
  partyGstin: {
    fontFamily: "Courier",
    fontSize:   9,
    color:      COLORS.ink2,
    marginTop:  2,
  },
  partyMeta: {
    fontSize: 9,
    color:    COLORS.ink3,
    marginTop: 2,
  },

  // Invoice meta (4 columns)
  metaRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:   14,
  },
  metaCell:  { flex: 1, paddingRight: 6 },
  metaLabel: {
    fontSize:      8,
    letterSpacing: 1.2,
    color:         COLORS.ink3,
    fontFamily:    "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom:  2,
  },
  metaValue: {
    fontSize: 10,
    color:    COLORS.ink,
  },
  metaMono: { fontFamily: "Courier", fontSize: 10 },

  // Line items
  table: {
    borderWidth: 1.5,
    borderColor: COLORS.ink,
    marginBottom: 12,
  },
  tableHeader: {
    flexDirection:    "row",
    backgroundColor:  "#F5F5F5",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.ink,
    paddingVertical:  6,
    paddingHorizontal: 6,
  },
  tableRow: {
    flexDirection:    "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingVertical:  6,
    paddingHorizontal: 6,
  },
  tableRowLast: {
    flexDirection:    "row",
    paddingVertical:  6,
    paddingHorizontal: 6,
  },
  thNum:  { width: 18, fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase" },
  thDesc: { flex: 4, fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase" },
  thHsn:  { width: 50, fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase" },
  thQty:  { width: 36, fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase", textAlign: "right" },
  thRate: { width: 60, fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase", textAlign: "right" },
  thAmt:  { width: 70, fontFamily: "Helvetica-Bold", fontSize: 8, textTransform: "uppercase", textAlign: "right" },

  tdNum:  { width: 18, fontSize: 9,  color: COLORS.ink3 },
  tdDesc: { flex: 4 },
  tdHsn:  { width: 50, fontFamily: "Courier", fontSize: 9, color: COLORS.ink2 },
  tdQty:  { width: 36, fontSize: 10, textAlign: "right" },
  tdRate: { width: 60, fontSize: 10, textAlign: "right" },
  tdAmt:  { width: 70, fontSize: 10, textAlign: "right", fontFamily: "Helvetica-Bold" },

  lineName: { fontFamily: "Helvetica-Bold", fontSize: 10 },

  emptyRow: {
    paddingVertical: 18,
    textAlign:       "center",
    color:           COLORS.ink3,
    fontStyle:       "italic",
    fontSize:        10,
  },

  // Totals
  totalsWrap: {
    flexDirection:  "row",
    justifyContent: "flex-end",
    marginBottom:   12,
  },
  totalsBox: { width: 260 },
  totalRow: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    paddingVertical: 3,
    fontSize:        10,
  },
  totalRowDivider: {
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop:     4,
    marginTop:      2,
  },
  grandTotalRow: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    borderTopWidth:  2,
    borderTopColor:  COLORS.ink,
    paddingTop:      8,
    marginTop:       4,
  },
  grandLabel: {
    fontFamily:    "Helvetica-Bold",
    fontSize:      9,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  grandValue: {
    fontFamily: "Helvetica-Bold",
    fontSize:   18,
  },
  netLabel:   { fontFamily: "Helvetica-Bold", fontSize: 10, color: COLORS.ink },
  netValue:   { fontFamily: "Helvetica-Bold", fontSize: 13 },
  totalLabel: { color: COLORS.ink3 },
  totalValue: { color: COLORS.ink },
  totalValueAccent: { color: COLORS.emerald },

  // Advance adjustment block
  advBlock: {
    backgroundColor: COLORS.emeraldSoft,
    borderWidth:     1,
    borderColor:     "#A7F3D0",
    borderRadius:    4,
    padding:         10,
    marginBottom:    14,
  },
  advHeader: {
    fontSize:      8,
    letterSpacing: 1.2,
    color:         "#047857",
    fontFamily:    "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom:  6,
  },
  advRow: {
    flexDirection:    "row",
    fontSize:         9,
    paddingVertical:  3,
    borderBottomWidth: 0.5,
    borderBottomColor: "#A7F3D0",
  },
  advRowLast: { flexDirection: "row", fontSize: 9, paddingVertical: 3 },
  advVoucher: { width: 100, fontFamily: "Courier" },
  advDate:    { width: 80 },
  advMethod:  { flex: 1 },
  advAmount:  { width: 70, textAlign: "right", fontFamily: "Helvetica-Bold" },
  advTotal: {
    flexDirection:   "row",
    justifyContent:  "space-between",
    fontSize:        10,
    marginTop:       6,
    paddingTop:      6,
    borderTopWidth:  1,
    borderTopColor:  "#A7F3D0",
    fontFamily:      "Helvetica-Bold",
  },

  // Footer
  footer: {
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop:     10,
    marginTop:      10,
  },
  footerLine: {
    fontSize:     9,
    color:        COLORS.ink3,
    marginBottom: 3,
    lineHeight:   1.4,
  },
  footerBold:   { fontFamily: "Helvetica-Bold", color: COLORS.ink2 },

  // Scan-to-pay block. ~28mm square at 72dpi — comfortably scannable from a
  // printed page, without dominating a document whose job is to be a tax record.
  upiRow: {
    flexDirection: "row",
    alignItems:    "center",
    marginTop:     10,
    paddingTop:    8,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
  },
  upiQr:    { width: 78, height: 78, marginRight: 10 },
  upiText:  { flex: 1 },
  upiTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: COLORS.ink2, marginBottom: 2 },
  upiSub:   { fontSize: 8, color: COLORS.ink3, lineHeight: 1.4 },
  upiVpa:   { fontSize: 9, fontFamily: "Helvetica-Bold", color: COLORS.ink2, marginTop: 2, marginBottom: 2 },
  reverseCharge: {
    fontSize:      9,
    color:         COLORS.ink2,
    marginTop:     6,
    fontFamily:    "Helvetica-Bold",
  },
});

// ─── Document ─────────────────────────────────────────────────────────────

export function InvoicePDF(props: InvoicePDFProps) {
  const {
    invoice, lineItems, subtotal, discountPct, discount, taxable, taxRate, tax, total,
    interState = false,
    customerGstin, customerEmail, customerAddress, customerState, customerCountry,
    currency, exchangeRate, termsConditions,
    tenantName, tenantGstin, tenantEmail, tenantPhone, tenantAddress, tenantState, tenantLogo,
    upiQrDataUrl, upiVpa,
  } = props;

  const cgst = interState ? 0 : Math.round(tax / 2);
  const sgst = interState ? 0 : tax - cgst;
  const igst = interState ? tax : 0;
  // Export supply (recipient outside India) → zero-rated under LUT, no GST.
  const isExport = isExportSupply(customerCountry);
  const isForeign = isForeignCurrency(currency);
  const rate = exchangeRate ?? 1;
  // Foreign-currency (export) invoices are shown in the CLIENT's currency (USD…)
  // — that's what an international customer asks for. The books stay ₹, so the INR
  // equivalent is printed as a GST/GSTR-1 reference. `money()` renders every amount
  // in the invoice's display currency.
  const money = (inr: number) => (isForeign ? formatForeign(foreignEquivalent(inr, rate), currency ?? "") : rupee(inr));

  const advances: InvoiceAdvanceAdjustment[] = invoice.adjusted_advances ?? [];
  const advancesTotal = advances.reduce((acc, a) => acc + a.amount, 0);
  const netPayable    = invoice.net_payable ?? Math.max(0, total - advancesTotal);

  return (
    <Document
      title={`Tax Invoice ${invoice.id}`}
      author={tenantName}
      subject={`Tax Invoice ${invoice.id} for ${invoice.customer_name}`}
    >
      <Page size="A4" style={s.page}>

        {/* ── Title ─────────────────────────────────────────────── */}
        <View style={s.titleBar}>
          {isRenderableLogo(tenantLogo) && <Image src={tenantLogo} style={s.brandLogo} />}
          <Text style={s.titleEyebrow}>Original for recipient · GST-compliant</Text>
          <Text style={s.titleMain}>Tax Invoice</Text>
          <Text style={s.titleId}>{invoice.id}</Text>
          {invoice.gst_irn && (
            <Text style={s.titleIrn}>IRN: {invoice.gst_irn}</Text>
          )}
        </View>

        {/* ── Supplier ↔ Recipient ─────────────────────────────── */}
        <View style={s.partiesBlock}>
          <View style={s.party}>
            <Text style={s.partyLabel}>From (Supplier)</Text>
            <Text style={s.partyName}>{tenantName}</Text>
            {tenantGstin   && <Text style={s.partyGstin}>GSTIN: {tenantGstin}</Text>}
            {tenantAddress && <Text style={s.partyMeta}>{tenantAddress}</Text>}
            {tenantState   && <Text style={s.partyMeta}>State: {tenantState}</Text>}
            {tenantEmail   && <Text style={[s.partyMeta, { fontFamily: "Courier" }]}>{tenantEmail}</Text>}
            {tenantPhone   && <Text style={[s.partyMeta, { fontFamily: "Courier" }]}>{tenantPhone}</Text>}
          </View>
          <View style={s.partyR}>
            <Text style={s.partyLabel}>Bill to (Recipient)</Text>
            <Text style={s.partyName}>{invoice.customer_name}</Text>
            {customerGstin   && <Text style={s.partyGstin}>GSTIN: {customerGstin}</Text>}
            {customerAddress && <Text style={s.partyMeta}>{customerAddress}</Text>}
            {customerState   && <Text style={s.partyMeta}>State: {customerState}</Text>}
            {customerEmail   && <Text style={[s.partyMeta, { fontFamily: "Courier" }]}>{customerEmail}</Text>}
          </View>
        </View>

        {/* ── Invoice meta row ─────────────────────────────────── */}
        <View style={s.metaRow}>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Invoice No.</Text>
            <Text style={[s.metaValue, s.metaMono]}>{invoice.id}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Invoice date</Text>
            <Text style={s.metaValue}>{formatDate(invoice.invoice_date)}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Due date</Text>
            <Text style={s.metaValue}>{invoice.due_date ? formatDate(invoice.due_date) : "—"}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Place of supply</Text>
            <Text style={s.metaValue}>
              {isExport ? `Export · ${customerCountry ?? "outside India"}` : interState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}
            </Text>
          </View>
        </View>

        {/* ── Line items ───────────────────────────────────────── */}
        <View style={s.table}>
          <View style={s.tableHeader}>
            <Text style={s.thNum}>#</Text>
            <Text style={s.thDesc}>Description</Text>
            <Text style={s.thHsn}>HSN/SAC</Text>
            <Text style={s.thQty}>Qty</Text>
            <Text style={s.thRate}>Rate</Text>
            <Text style={s.thAmt}>Amount</Text>
          </View>
          {lineItems.length === 0 ? (
            <Text style={s.emptyRow}>No line items recorded on the parent quote.</Text>
          ) : (
            lineItems.map((li, i) => (
              <View
                key={li.id}
                style={i === lineItems.length - 1 ? s.tableRowLast : s.tableRow}
                wrap={false}
              >
                <Text style={s.tdNum}>{i + 1}</Text>
                <View style={s.tdDesc}>
                  <Text style={s.lineName}>{li.name}</Text>
                  {li.description && (
                    <Text style={{ fontSize: 9, color: COLORS.ink3, marginTop: 2 }}>
                      {li.description}
                    </Text>
                  )}
                </View>
                <Text style={s.tdHsn}>998313</Text>
                <Text style={s.tdQty}>{li.qty}</Text>
                <Text style={s.tdRate}>{money(li.rate)}</Text>
                <Text style={s.tdAmt}>{money(li.qty * li.rate)}</Text>
              </View>
            ))
          )}
        </View>

        {/* ── Totals ───────────────────────────────────────────── */}
        <View style={s.totalsWrap}>
          <View style={s.totalsBox}>
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>Subtotal</Text>
              <Text style={s.totalValue}>{money(subtotal)}</Text>
            </View>
            {discountPct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Discount ({discountPct}%)</Text>
                <Text style={s.totalValueAccent}>-{money(discount)}</Text>
              </View>
            )}
            <View style={[s.totalRow, s.totalRowDivider]}>
              <Text style={s.totalLabel}>Taxable value</Text>
              <Text style={s.totalValue}>{money(taxable)}</Text>
            </View>
            {isExport ? (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Export — zero-rated (LUT), no GST</Text>
                <Text style={s.totalValue}>{money(0)}</Text>
              </View>
            ) : interState ? (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>IGST @ {taxRate}%</Text>
                <Text style={s.totalValue}>{money(igst)}</Text>
              </View>
            ) : (
              <>
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>CGST @ {taxRate / 2}%</Text>
                  <Text style={s.totalValue}>{money(cgst)}</Text>
                </View>
                <View style={s.totalRow}>
                  <Text style={s.totalLabel}>SGST @ {taxRate / 2}%</Text>
                  <Text style={s.totalValue}>{money(sgst)}</Text>
                </View>
              </>
            )}
            <View style={s.grandTotalRow}>
              <Text style={s.grandLabel}>Invoice total</Text>
              <Text style={s.grandValue}>{money(total)}</Text>
            </View>
            {isForeign && (
              /* Books stay ₹ — print the INR equivalent for GST / GSTR-1 filing. */
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>INR equivalent (for GST) @ Rs {exchangeRate}/{currency}</Text>
                <Text style={s.totalValue}>{rupee(total)}</Text>
              </View>
            )}
          </View>
        </View>

        {/* ── Advance adjustment (CGST Sec 31 + Rule 53) ──────── */}
        {advances.length > 0 && (
          <View style={s.advBlock}>
            <Text style={s.advHeader}>✓ Advances adjusted against this invoice</Text>
            {advances.map((adv, i) => (
              <View
                key={`${adv.payment_id}-${i}`}
                style={i === advances.length - 1 ? s.advRowLast : s.advRow}
              >
                <Text style={s.advVoucher}>{adv.voucher_no ?? "—"}</Text>
                <Text style={s.advDate}>{formatDate(adv.received_at)}</Text>
                <Text style={s.advMethod}>{adv.method.toUpperCase()}</Text>
                <Text style={s.advAmount}>{money(adv.amount)}</Text>
              </View>
            ))}
            <View style={s.advTotal}>
              <Text>Advance adjusted</Text>
              <Text>{money(advancesTotal)}</Text>
            </View>
            <View style={[s.advTotal, { borderTopWidth: 0, paddingTop: 2, marginTop: 2 }]}>
              <Text style={s.netLabel}>Net payable</Text>
              <Text style={s.netValue}>{money(netPayable)}</Text>
            </View>
          </View>
        )}

        {/* ── Footer ───────────────────────────────────────────── */}
        <View style={s.footer}>
          <Text style={s.reverseCharge}>
            Whether tax is payable under reverse charge: <Text style={{ fontFamily: "Helvetica" }}>No</Text>
          </Text>
          <Text style={[s.footerLine, { marginTop: 6 }]}>
            <Text style={s.footerBold}>HSN/SAC: </Text>
            998313 (Software licensing / SaaS) · <Text style={s.footerBold}>GSTR-1 month: </Text>
            {formatDate(invoice.invoice_date)}
          </Text>
          <Text style={s.footerLine}>
            <Text style={s.footerBold}>Payment terms: </Text>
            {invoice.due_date ? `Due by ${formatDate(invoice.due_date)}. ` : ""}UPI / NEFT / Razorpay accepted.
          </Text>

          {/* Scan-to-pay. Drawn only when the tenant has set a UPI ID — no
              placeholder box, because an un-scannable QR on a tax invoice is
              worse than none. The VPA is printed underneath so a payer whose
              camera struggles can still type it. */}
          {upiQrDataUrl ? (
            <View style={s.upiRow}>
              <Image src={upiQrDataUrl} style={s.upiQr} />
              <View style={s.upiText}>
                <Text style={s.upiTitle}>Scan to pay</Text>
                <Text style={s.upiSub}>
                  Any UPI app — GPay, PhonePe, Paytm, BHIM.
                </Text>
                {upiVpa ? <Text style={s.upiVpa}>{upiVpa}</Text> : null}
                <Text style={s.upiSub}>
                  Amount and invoice number are pre-filled.
                </Text>
              </View>
            </View>
          ) : null}
          {termsConditions?.trim() ? (
            <Text style={[s.footerLine, { marginTop: 6 }]}>
              <Text style={s.footerBold}>Terms &amp; conditions: </Text>
              {termsConditions.trim()}
            </Text>
          ) : null}
          <Text style={[s.footerLine, { marginTop: 8, fontFamily: "Helvetica-Bold", color: COLORS.ink2 }]}>
            For {tenantName}
          </Text>
          <Text style={[s.footerLine, { fontSize: 8 }]}>
            (Authorised signatory · This is a computer-generated invoice — no physical signature required.)
          </Text>
        </View>
      </Page>
    </Document>
  );
}
