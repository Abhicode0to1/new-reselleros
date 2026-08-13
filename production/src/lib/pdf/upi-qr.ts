/**
 * Renders a UPI intent into a PNG data-URL for embedding in a PDF.
 *
 * Server-only: `qrcode` is imported dynamically so it never reaches a client
 * bundle, and only loads when a PDF is actually rendered.
 *
 * DESIGN RULE: a QR is a nice-to-have on a tax invoice; the invoice itself is a
 * legal document. So every failure path here returns null and the PDF renders
 * without the QR — never throws. A missing QR costs a scan; a thrown error
 * costs the customer their invoice.
 */
import { invoiceUpiIntent } from "@/lib/payments/upi";

export interface UpiQr {
  dataUrl: string;
  /** Shown under the QR so the payer can type it if their camera struggles. */
  vpa: string;
}

/**
 * Build the QR for an invoice. Returns null when the tenant has no UPI ID, the
 * VPA is malformed, or encoding fails — all of which mean "print no QR".
 */
export async function buildInvoiceUpiQr(args: {
  vpa: string | null | undefined;
  payeeName: string | null | undefined;
  invoiceId: string;
  amountDue: number | null | undefined;
}): Promise<UpiQr | null> {
  const uri = invoiceUpiIntent(args);
  if (!uri || !args.vpa) return null;

  try {
    const QRCode = await import("qrcode");
    const dataUrl = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",   // survives a phone camera at an angle
      margin: 1,                   // quiet zone; 0 makes some scanners fail
      width: 320,                  // crisp when printed at ~28mm
      color: { dark: "#1A1815", light: "#FFFFFF" },  // --ink on white
    });
    return { dataUrl, vpa: args.vpa.trim() };
  } catch {
    // Encoding failed — print the invoice anyway.
    return null;
  }
}
