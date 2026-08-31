/**
 * Text a built-in PDF font can actually DRAW — and what to do about the rest.
 *
 * ─── WHY THIS EXISTS AS A CLASS, NOT A PATCH ────────────────────────────────
 * 31 Aug 2026 the rupee sign turned out to be missing from every PDF this app produces: the
 * base-14 faces (Helvetica, Courier, Times) are drawn under WinAnsiEncoding, `₹` is not in
 * WinAnsi, and the viewer substituted a superscript 1. That was fixed for money.
 *
 * An audit the same afternoon found the fix had been too narrow, twice over:
 *
 *   1. `InvoicePDF.tsx:556` prints "✓ Advances adjusted against this invoice". U+2713 is not
 *      in WinAnsi either, so every invoice with an adjusted advance carried a second broken
 *      mark. It was on screen next to the rupee bug and I only looked at the rupee.
 *
 *   2. Far more of the document is text WE DO NOT WRITE. `customerName`, `notes`,
 *      `termsConditions`, a line's `name`, both addresses — all flow straight through. A
 *      tenant who types ₹ into their Terms, a customer called something in Devanagari, a
 *      pasted "→" or "≥": same broken mark, on a GST document, and nothing in the code would
 *      look wrong.
 *
 * So the question stops being "did we remember to convert this figure" and becomes "can the
 * font draw this string at all". That is a property of the text, so it belongs to a function
 * every PDF string passes through.
 *
 * ─── WHAT IT DOES ───────────────────────────────────────────────────────────
 * Known characters get a readable ASCII equivalent — `₹` → `Rs `, `✓` → `+`, `→` → `->`. What
 * is left over is dropped rather than guessed at: a missing character reads as a typo, while
 * the substituted glyph reads as corruption, and on an invoice the second is worse. Dropping
 * also cannot make the string longer, so no layout shifts.
 *
 * Deliberately NOT a font. An embedded TTF would draw all of this properly and is the better
 * answer for a future change — Pardeep asked for it and it is worth doing — but it puts an
 * asset in the renderer's load path, and a font that fails to load takes the document with
 * it. This works with no asset at all.
 */

/**
 * WinAnsi's additions above Latin-1: the euro, the smart quotes, the dashes, the bullet.
 *
 * Worth knowing because these DO render: the em dash used across these documents, and the
 * middle dot in "Per seat · HSN 998313", are both safe. Only what is missing from this list
 * AND outside Latin-1 needs handling.
 */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Can a base-14 PDF font draw this code point? */
export function drawableInWinAnsi(codePoint: number): boolean {
  if (codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x09) return true;
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;   // ASCII
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;   // Latin-1
  return WINANSI_EXTRA.has(codePoint);
}

/**
 * Readable stand-ins for the characters that actually turn up in this app's documents.
 *
 * Each one earns its place by having appeared, or by being a plausible paste into a Terms
 * box. Anything not listed is dropped — see the header for why that is the safer default.
 */
const SUBSTITUTES: Readonly<Record<string, string>> = {
  "₹": "Rs ",   // ₹  the one that started this
  "₨": "Rs ",   // ₨  the older rupee ligature
  "✓": "+",     // ✓  InvoicePDF's advances header
  "✔": "+",     // ✔
  "✗": "x",     // ✗
  "✘": "x",     // ✘
  "→": "->",    // →
  "←": "<-",    // ←
  "≥": ">=",    // ≥
  "≤": "<=",    // ≤
  "≠": "!=",    // ≠
  " ": " ",     // no-break space: drawable, but it defeats wrapping in a table cell
  "‑": "-",     // non-breaking hyphen
  "‒": "-",     // figure dash
  "―": "-",     // horizontal bar
  "­": "",      // soft hyphen — invisible on screen, a stray dash in a PDF
};

/**
 * Make any string safe to hand `<Text>`.
 *
 * Idempotent, and safe on text that is already clean — most strings pass through untouched,
 * so it can be applied everywhere without thinking about which fields "might" be dirty. That
 * is the point: the previous version of this rule required remembering, and remembering is
 * what failed.
 */
export function pdfText(value: string | null | undefined): string {
  if (value == null) return "";
  let out = "";
  for (const ch of value) {
    const sub = SUBSTITUTES[ch];
    if (sub !== undefined) { out += sub; continue; }
    if (drawableInWinAnsi(ch.codePointAt(0) ?? 0)) { out += ch; continue; }
    /* Dropped on purpose. A gap reads as a typo; a substituted glyph reads as corruption,
       and on a tax invoice the second is the worse of the two. */
  }
  return out;
}

/** Every character in this string that the font cannot draw. For tests and audits. */
export function undrawable(value: string): string[] {
  const out: string[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!drawableInWinAnsi(cp) && SUBSTITUTES[ch] === undefined) out.push(ch);
  }
  return out;
}
