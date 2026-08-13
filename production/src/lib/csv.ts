/**
 * CSV export helpers — shared so every report (GST, P&L, Balance Sheet, …) hands
 * the CA the same, spreadsheet-clean format. Amounts are written as raw integer ₹
 * (the app's canonical money unit), not formatted strings, so Excel/Tally treats
 * them as numbers.
 *
 * ─── TWO THINGS THIS FILE GUARDS AGAINST ─────────────────────────────────────
 *
 * 1. FORMULA INJECTION. Excel and LibreOffice execute a cell that begins with
 *    `=`, `+`, `@`, or a tab/CR. Customer names, vendor names and note fields are
 *    user-typed and land in these exports, so a customer called `=cmd|'…'!A1`
 *    runs on the CA's laptop when they open the file. Guarded fields get a
 *    leading apostrophe, which spreadsheets strip on display.
 *
 *    `-` is deliberately NOT treated as dangerous on its own: `-4500` is an
 *    ordinary credit in every accounting export here, and quoting it as text
 *    would stop the CA summing the column — breaking the report to prevent a
 *    threat that a leading minus does not actually carry. Only a `-` followed by
 *    something that is not a number is guarded.
 *
 * 2. EXCEL ON WINDOWS AND UTF-8. Without a byte-order mark, Excel reads the file
 *    in the system codepage: `₹` becomes `â‚¹` and any Hindi or accented customer
 *    name turns to mojibake. The BOM is three bytes that make the difference
 *    between a usable export and one the CA emails back.
 */

/** Leading characters a spreadsheet will treat as the start of a formula. */
const FORMULA_LEAD = /^[=+@\t\r]/;

/** A field that is a plain number — safe to leave exactly as typed. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Neutralise a value a spreadsheet would otherwise execute.
 * Exported for tests; `csvEscape` applies it for you.
 */
export function deFormula(v: string): string {
  if (FORMULA_LEAD.test(v)) return `'${v}`;
  // Leading `-` is only dangerous when it isn't simply a negative number.
  if (v.startsWith("-") && !NUMERIC.test(v)) return `'${v}`;
  return v;
}

/**
 * Escape a CSV field (RFC 4180): quote it when it contains a comma, quote, or
 * line break, and neutralise spreadsheet formulas first.
 *
 * Numbers skip the formula guard entirely — they cannot carry one, and a
 * quoted number stops being summable.
 */
export function csvEscape(s: string | number | null | undefined): string {
  if (typeof s === "number") {
    return Number.isFinite(s) ? String(s) : "";
  }
  const v = deFormula(String(s ?? ""));
  // \r matters as well as \n: a lone CR inside a field breaks strict parsers.
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Build a CSV string from headers + rows. Separated from the download so it can be tested. */
export function buildCSV(headers: string[], rows: (string | number)[][]): string {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((r) => r.map(csvEscape).join(",")),
  ].join("\r\n"); // RFC 4180 says CRLF; Excel on Windows is happiest with it.
}

/** Build a CSV string from headers + rows and trigger a browser download. */
export function downloadCSV(
  filename: string,
  headers: string[],
  rows: (string | number)[][],
): void {
  const blob = new Blob(
    ["\uFEFF", buildCSV(headers, rows)], // BOM first — see note 2 above.
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
