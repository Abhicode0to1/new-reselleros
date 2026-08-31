/**
 * Money, written so a PDF can actually DRAW it.
 *
 * ─── THE DOCUMENT THAT FOUND THIS ───────────────────────────────────────────
 * 31 Aug 2026, Q-ADPL-2026-27-0058 as it reached the customer's inbox:
 *
 *     RATE  ¹325/mo      AMOUNT  ¹12,675/mo      PER INVOICE  ¹14,957/mo
 *
 * A small superscript 1 where every rupee sign should be. Not a stray character — the
 * OPPOSITE: `₹` (U+20B9) is missing from the font, so the viewer drew whatever it had.
 *
 * `@react-pdf/renderer` with no `Font.register` uses the PDF base-14 faces (Helvetica,
 * Courier, Times) under WinAnsiEncoding. WinAnsi covers Latin-1 plus a handful of extras —
 * the em dash, the curly quotes, the euro — and it has NO rupee sign, because the character
 * was only assigned in Unicode in 2010, long after those encodings were fixed.
 *
 * So every quote, invoice, receipt voucher and payslip this app has ever produced has printed
 * a broken glyph in place of the currency, on GST documents, and the screens were fine the
 * whole time — a browser has fonts that cover ₹, and `rupee()` is shared between them.
 *
 * ─── WHY "Rs " AND NOT AN EMBEDDED FONT ─────────────────────────────────────
 * An embedded TTF would draw the real ₹. It also puts a font file inside the renderer's load
 * path — and today already showed what that costs: the logo needed a deadline, a byte sniff
 * and a fallback before it was safe to put an image in this path. A font that fails to load
 * does not degrade to a monogram; it takes the document with it.
 *
 * "Rs" is what Indian invoices have printed for decades, Tally included. It cannot fail to
 * render, it needs no asset, and it is unambiguous. If the ₹ glyph is wanted later, it is a
 * deliberate change with its own tests — not a thing to risk on a money document today.
 *
 * ─── AND THE GROUPING IS NOT REIMPLEMENTED ──────────────────────────────────
 * This wraps `rupee()` rather than formatting afresh. Indian lakh/crore grouping is the part
 * that would actually be dangerous to duplicate: two functions producing "12,675" and
 * "12675" for one amount is how a document comes to disagree with the row behind it.
 */
import { rupee } from "@/lib/utils";
import { pdfText, rupeeIsDrawable } from "./pdf-text";

/** What replaces `₹`. A trailing space is included so "Rs 325" reads correctly. */
export const PDF_RUPEE_PREFIX = "Rs ";

/**
 * The one character the base-14 fonts cannot draw in this app's output.
 *
 * `$ € £` are all in WinAnsi, and `AED ` / `S$` / `A$` / `C$` are ASCII, so the foreign path
 * needs nothing. The em dash and middle dot used across these documents are in WinAnsi too —
 * which is why they render and this one does not.
 */
const RUPEE_SIGN = "₹";

/**
 * Replace any rupee sign in already-formatted text with `Rs `.
 *
 * Takes formatted text rather than a number so it can be applied to anything a PDF renders —
 * a total, a per-seat rate, a sentence in the notes that happens to quote a figure.
 */
export function pdfSafeMoney(text: string): string {
  /* The sign may already be followed by a space (from a hand-written string); collapse the two
     rather than printing "Rs  325".

     The general case lives in pdf-text.ts now — `₹` was never the only character the font
     cannot draw, and an audit on 31 Aug found `✓` on the invoice plus every field of text the
     TENANT types. This function stays because money has one more rule than text does: the
     grouping must come from `rupee()` and not be re-derived. */
  /* With an embedded font the sign draws, so nothing is replaced — `pdfText` still runs,
     because the rest of a money string (a stray no-break space from a paste) still needs it. */
  if (rupeeIsDrawable()) return pdfText(text);
  return pdfText(text.split(new RegExp(`${RUPEE_SIGN}\\s?`, "g")).join(PDF_RUPEE_PREFIX));
}

/**
 * `rupee()`, but drawable. Use this in every PDF component instead of `rupee()`.
 *
 * `pdf-money.wiring.test.ts` counts the call sites: a PDF that reaches for `rupee()` directly
 * is a document that prints a broken glyph, and nothing about the code would look wrong.
 */
export function pdfRupee(
  n: number | null | undefined,
  opts?: Parameters<typeof rupee>[1],
): string {
  return pdfSafeMoney(rupee(n, opts));
}
