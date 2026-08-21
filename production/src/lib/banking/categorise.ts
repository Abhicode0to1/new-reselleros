import type { TxnRuleDirection } from "@/lib/supabase/database.types";

/**
 * Give a bank line a category, deterministically, from the tenant's own rules.
 *
 * ─── WHY RULES AND NOT A MODEL, FOR THIS PART ───────────────────────────────
 * Three real unmatched narrations from the live books:
 *
 *   IMPS-621856395591-PARDEEP SHARMA-ICIC-XX XXXXXX4658-SALARY
 *   DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL
 *   K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK
 *
 * The answer is written in the text. A substring match gets all three right, instantly,
 * for free, and — the part a model cannot offer — with a reason an accountant can check
 * and argue with. AI belongs on the leftovers (Phase 3), not on the recurring spend that
 * makes up most of a month.
 *
 * The other reason is the data: 35 categorised expenses across 8 categories, and Salaries
 * is 22 of them. That is not enough to train anything, so the deterministic layer is not a
 * stopgap until the clever version arrives — it IS the mechanism, and operator corrections
 * grow it (Phase 4).
 *
 * ─── DETERMINISM IS THE WHOLE POINT ─────────────────────────────────────────
 * The same line must always produce the same category. A categoriser that answers
 * differently on two runs cannot be reconciled, cannot be audited, and turns a closed
 * month back into an open one. So every tie is broken explicitly, and nothing here reads
 * the clock, a random source, or rule insertion order.
 *
 * ─── NO WRITES, NO AMOUNTS ──────────────────────────────────────────────────
 * This module returns a suggestion. It never posts anything (the posture every AI route in
 * this repo already takes), and it never touches `debit`/`credit` — it reads the direction
 * to decide, and passes no money through.
 */

/**
 * A rule as stored in `txn_category_rules`.
 *
 * `direction` is imported rather than re-spelled here. The same three words live in a DB
 * check constraint and in the generated types, and on 21 Aug this codebase shipped a table
 * accepting 'checkin' while the app had always said 'check_in' — one vocabulary written
 * twice is one vocabulary that will disagree with itself.
 */
export interface CategoryRule {
  id: string;
  /** Matched case-insensitively as a substring of the narration. */
  pattern: string;
  category: string;
  /**
   * Which side of the statement this rule may fire on.
   *
   * Not a nicety — a correctness guard. "SALARY" appearing in a CREDIT is money coming
   * IN, which is a refund or a reversal, not a salary expense. A direction-blind rule
   * would file it under Salaries and quietly overstate the wage bill.
   */
  direction: TxnRuleDirection;
}

export interface CategoryMatch {
  category: string;
  /** The rule that decided it, so the UI can show its reason. */
  rule: CategoryRule;
  /** Human-readable, for the operator: `rule: PAYUFACEBOOK`. */
  reason: string;
}

/** Just enough of a bank line. */
export interface BankLine {
  description: string | null;
  debit: number;
  credit: number;
}

/**
 * Which side of the statement a line sits on.
 *
 * Returns null when it is neither or both — a zero-value line, or a malformed row with
 * both sides filled. `extract-statement` already rejects "both" rows, but this module is
 * also used on rows imported by other paths, and guessing a direction is how a rule fires
 * on a line nobody can classify.
 */
export function directionOf(line: BankLine): "debit" | "credit" | null {
  const d = line.debit > 0;
  const c = line.credit > 0;
  if (d && c) return null;
  if (d) return "debit";
  if (c) return "credit";
  return null;
}

/** Uppercase, and collapse the runs of separators bank narrations are full of. */
function normalise(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * The first rule that matches, by an explicit precedence:
 *
 *   1. A direction-specific rule beats `any`. Somebody who wrote a debit-only rule was
 *      being more careful than somebody who did not, and that care should win.
 *   2. Then the LONGEST pattern. "GOOGLEADS" is more specific than "GOOGLE", and the more
 *      specific statement of intent is the one to honour.
 *   3. Then the lowest id, purely so the answer never depends on the order rows came back
 *      from Postgres. A `select` without `order by` may return rules in any order, and a
 *      categoriser whose output depends on that is not deterministic even though every
 *      individual comparison is.
 *
 * Returns null when nothing matches. Null means "no rule covers this", which is a real and
 * common answer — it must stay visibly different from a category, or an uncategorised line
 * reads as one that needed no category.
 */
export function categoriseByRules(line: BankLine, rules: readonly CategoryRule[]): CategoryMatch | null {
  const text = normalise(line.description ?? "");
  if (!text) return null;

  const direction = directionOf(line);
  if (direction === null) return null;

  const candidates = rules.filter((r) => {
    if (r.direction !== "any" && r.direction !== direction) return false;
    const pattern = normalise(r.pattern);
    /* An empty pattern would match every line. Guarded here rather than trusting the
       insert, because one blank row would silently categorise the whole statement. */
    if (!pattern) return false;
    return text.includes(pattern);
  });

  if (candidates.length === 0) return null;

  const best = [...candidates].sort((a, b) => {
    const aSpecific = a.direction !== "any" ? 1 : 0;
    const bSpecific = b.direction !== "any" ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    const lenDiff = normalise(b.pattern).length - normalise(a.pattern).length;
    if (lenDiff !== 0) return lenDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];

  return { category: best.category, rule: best, reason: `rule: ${best.pattern}` };
}

/**
 * Categorise a batch, and report what was left over.
 *
 * The leftovers are the point: they are Phase 3's input, and they are also the honest
 * measure of how well the rules are doing. A function that returned only the successes
 * would make a half-covered statement look finished.
 */
export function categoriseBatch<T extends BankLine>(
  lines: readonly T[],
  rules: readonly CategoryRule[],
): { matched: { line: T; match: CategoryMatch }[]; unmatched: T[] } {
  const matched: { line: T; match: CategoryMatch }[] = [];
  const unmatched: T[] = [];
  for (const line of lines) {
    const match = categoriseByRules(line, rules);
    if (match) matched.push({ line, match });
    else unmatched.push(line);
  }
  return { matched, unmatched };
}
