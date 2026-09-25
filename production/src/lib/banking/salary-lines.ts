/**
 * Salary lines on a bank statement → who was paid, for which month.
 *
 * Indian bank narrations for salary transfers are regular enough to read without a
 * model — e.g. HDFC:
 *   50100784857169-TPT-SALARY APR 2026-PAWAN
 *   50100784857182-TPT-EMP MAY SALARY-HITESH BABU
 *   50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK
 * The payee is the last "-" segment; the month, when present, is a month word with an
 * optional year.
 *
 * ─── WHAT IT DOES NOT PRETEND TO KNOW ───────────────────────────────────────
 *  • No month in the narration → the month BEFORE the payment (salary is normally paid
 *    for the month just ended), flagged `periodFromNarration: false` so the screen can
 *    say it was assumed and let the operator change it.
 *  • No readable name → `name: null`; the operator picks the employee.
 *  • "ADVANCE" lines are not salary — an advance is a loan against future pay and has
 *    its own flow — so they are not offered at all.
 */

const MONTHS: Array<[RegExp, number]> = [
  [/^JAN(UARY)?$/, 1], [/^FEB(RUARY)?$/, 2], [/^MAR(CH)?$/, 3], [/^APR(IL)?$/, 4],
  [/^MAY$/, 5], [/^JUNE?$/, 6], [/^JULY?$/, 7], [/^AUG(UST)?$/, 8],
  [/^SEPT?(EMBER)?$/, 9], [/^OCT(OBER)?$/, 10], [/^NOV(EMBER)?$/, 11], [/^DEC(EMBER)?$/, 12],
];

function monthOf(word: string): number | null {
  for (const [re, m] of MONTHS) if (re.test(word)) return m;
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The month before an ISO date, as YYYY-MM. */
export function previousPeriod(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

export type SalaryNarration = {
  /** Payee as written on the statement, or null when none could be read. */
  name: string | null;
  /** YYYY-MM */
  period: string;
  periodFromNarration: boolean;
  fullAndFinal: boolean;
};

export function parseSalaryNarration(description: string, txnDate: string): SalaryNarration | null {
  const text = description.toUpperCase();
  if (!/\bSALARY\b/.test(text)) return null;
  if (/\bADVANCE\b/.test(text)) return null;

  const segments = text.split("-").map((s) => s.trim()).filter(Boolean);

  /* Payee. Transfers within the bank (TPT) put it LAST; IMPS / NEFT / RTGS put it
     third — IMPS-<ref>-<NAME>-<bank>-<account>-<remark>. Either way it must be words
     and not the SALARY segment itself. */
  const isName = (s: string | undefined) => !!s && /^[A-Z][A-Z .]*[A-Z.]$/.test(s) && !/\bSALARY\b/.test(s);
  let nameIdx = -1;
  if (isName(segments[segments.length - 1])) nameIdx = segments.length - 1;
  else if (/^(IMPS|NEFT|RTGS)$/.test(segments[0] ?? "") && isName(segments[2])) nameIdx = 2;
  const name = nameIdx >= 0 ? segments[nameIdx].replace(/\s+/g, " ") : null;

  /* Month: search every segment except the payee's (a name like "MAY" must not count). */
  const searchable = segments.filter((_, i) => i !== nameIdx).join(" ");
  const words = searchable.split(/[^A-Z0-9']+/).filter(Boolean);
  let period: string | null = null;
  const [ty, tm] = txnDate.split("-").map(Number);
  for (let i = 0; i < words.length; i++) {
    const m = monthOf(words[i]);
    if (!m) continue;
    const next = (words[i + 1] ?? "").replace(/^'/, "");
    let y: number;
    if (/^\d{4}$/.test(next)) y = Number(next);
    else if (/^\d{2}$/.test(next)) y = 2000 + Number(next);
    /* No year: the latest such month not after the payment. */
    else y = m > tm ? ty - 1 : ty;
    period = `${y}-${pad2(m)}`;
    break;
  }

  return {
    name,
    period: period ?? previousPeriod(txnDate),
    periodFromNarration: period !== null,
    fullAndFinal: /\bFULL\s*(N|AND|&)\s*FINAL\b|\bF\s*&\s*F\b|\bFNF\b/.test(text),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

export type EmployeeMatch =
  | { kind: "match"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

/**
 * Statement name → employee. Tries, in order, and stops at the first rule that
 * yields exactly ONE employee: the whole name; every statement word present in the
 * employee's name ("PAWAN" → "Pawan Kumar"). Two or more candidates is `ambiguous`,
 * never a pick — two Rahuls are the operator's call.
 */
export function matchEmployee(name: string | null, employees: Array<{ id: string; name: string }>): EmployeeMatch {
  if (!name) return { kind: "none" };
  const target = norm(name);
  if (!target) return { kind: "none" };

  const exact = employees.filter((e) => norm(e.name) === target);
  if (exact.length === 1) return { kind: "match", id: exact[0].id };
  if (exact.length > 1) return { kind: "ambiguous", ids: exact.map((e) => e.id) };

  const words = target.split(" ");
  const contains = employees.filter((e) => {
    const have = new Set(norm(e.name).split(" "));
    return words.every((w) => have.has(w));
  });
  if (contains.length === 1) return { kind: "match", id: contains[0].id };
  if (contains.length > 1) return { kind: "ambiguous", ids: contains.map((e) => e.id) };
  return { kind: "none" };
}

/** "RANJEET RAJ" → "Ranjeet Raj", for a new employee created from a statement line. */
export function titleCaseName(name: string): string {
  return name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
