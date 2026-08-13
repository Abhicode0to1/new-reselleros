/**
 * Deterministic verification of money figures in AI-drafted text.
 *
 * THE PRINCIPLE THIS IMPLEMENTS: "AI thinks and drafts, code validates and
 * executes." The drafting side was already careful — outstanding balances are
 * computed server-side and handed to the model as immutable context with
 * "use EXACTLY this, do not change". But an instruction in a prompt is a
 * REQUEST, not a constraint. The model can restate ₹4,500 as ₹45,000, and
 * nothing downstream noticed: the draft was returned to the operator as-is.
 *
 * That is the whole failure. The operator reads a fluent, plausible payment
 * reminder, sends it, and a customer is asked for money they do not owe. The
 * damage is not a wrong pixel — it is a wrong invoice-shaped claim, made in the
 * reseller's name, to their customer.
 *
 * So this is the "code validates" half: extract every figure the draft presents
 * as money, and refuse the draft if any of them is not a number we authorised.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not flag bare numbers by default.
 * A draft legitimately says "22 seats", "18% GST", "Net 7 days", "13 Aug 2026".
 * A guard that rejected those would reject nearly every draft, get switched off
 * within a week, and protect nothing. Currency-marked figures are the ones that
 * carry a monetary claim, and they are what the model produces when it restates
 * a number from context. `bareNumberFloor` exists for callers that want the
 * stricter sweep, and its limits are stated on the option itself.
 *
 * Indian formatting is first-class: ₹45,000 · Rs. 45000 · INR 45,000 · 45,000/- ·
 * ₹4.5 lakh · ₹1.2 cr all normalise to the same rupee value, because rejecting a
 * CORRECT message written as "₹4.5 lakh" would be its own kind of false alarm.
 */

export interface MoneyGuardOptions {
  /**
   * Also treat any bare (unmarked) number at or above this value as a monetary
   * claim. Off by default. Set it and you catch "your outstanding is 45000",
   * but you also catch a seat count of 50,000 or a year written as a number —
   * so use it where drafts are short and money-focused, like reminders.
   */
  bareNumberFloor?: number;
}

export interface MoneyGuardResult {
  /** True when every monetary figure in the text was authorised. */
  ok: boolean;
  /** Rupee values found, normalised, in order of appearance. */
  found: number[];
  /** Figures as literally written that were NOT authorised — for the log. */
  violations: string[];
}

const LAKH  = 100_000;
const CRORE = 10_000_000;

/**
 * Currency-marked amounts. Matches a ₹/Rs/Rs./INR prefix, or a `/-` suffix,
 * around a number that may carry Indian comma grouping and a lakh/crore word.
 */
const MARKED = new RegExp(
  [
    // ₹1,20,000.50 / Rs. 4500 / INR 45,000 / ₹4.5 lakh
    String.raw`(?:₹|\bRs\.?|\bINR\b)\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|lakh|crores?|cr\b|L\b)?`,
    // 45,000/- — the suffix form, common in Indian invoices and messages
    String.raw`([\d,]+(?:\.\d+)?)\s*/-`,
  ].join("|"),
  "gi",
);

/** Bare numbers, used only when bareNumberFloor is set. */
const BARE = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)(?![\d.,])/g;

/** Normalise a captured number + optional scale word into rupees. */
function toRupees(digits: string, scale?: string): number | null {
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = (scale ?? "").toLowerCase();
  if (s.startsWith("lakh") || s.startsWith("lac") || s === "l") return Math.round(n * LAKH);
  if (s.startsWith("crore") || s.startsWith("cr")) return Math.round(n * CRORE);
  return Math.round(n);
}

/**
 * Verify that every monetary figure in `text` appears in `allowed`.
 *
 * `allowed` is the set of numbers the caller computed and put in the prompt.
 * Zero is always permitted: "no outstanding balance" is a legitimate thing for a
 * draft to say and is never a harmful claim.
 */
export function verifyDraftMoney(
  text: string,
  allowed: readonly number[],
  opts: MoneyGuardOptions = {},
): MoneyGuardResult {
  const ok = new Set<number>([0, ...allowed.map((a) => Math.round(a))]);
  const found: number[] = [];
  const violations: string[] = [];

  const consider = (raw: string, value: number | null) => {
    if (value === null) return;
    found.push(value);
    if (!ok.has(value)) violations.push(raw.trim());
  };

  for (const m of text.matchAll(MARKED)) {
    // Group 1+2 = prefixed form, group 3 = the `/-` suffix form.
    if (m[1] !== undefined) consider(m[0], toRupees(m[1], m[2]));
    else if (m[3] !== undefined) consider(m[0], toRupees(m[3]));
  }

  if (opts.bareNumberFloor !== undefined) {
    // Blank out the marked matches first, so a figure is never judged twice —
    // once as "₹45,000" and again as the bare "45,000" inside it.
    const masked = text.replace(MARKED, (s) => " ".repeat(s.length));
    for (const m of masked.matchAll(BARE)) {
      const v = toRupees(m[1]);
      if (v !== null && v >= opts.bareNumberFloor) consider(m[0], v);
    }
  }

  return { ok: violations.length === 0, found, violations };
}
