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

/* ──────────────────────────────────────────────────────────────────────────────
   Two layers, and the order matters
   ──────────────────────────────────────────────────────────────────────────────

   `suggestCategory` in lib/queries/expenses.ts already existed before any of this and
   is good: 18 canonical categories, keyword regexes in English AND Hinglish, ordered
   most-specific-first, returns null rather than guessing. Reusing it beats writing a
   second keyword list that would drift from it.

   But it cannot do this job alone, for two measured reasons:

   1. Its patterns are `\b`-anchored, because it was built for the free text an operator
      TYPES ("team ke liye khana"). Bank narrations are machine noise with no word
      boundaries — DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL has no \b before GOOGL, so no
      word-anchored pattern can ever reach it. Substring rules can.

   2. It deliberately never returns "Salaries" — its own comment says those belong in
      Payroll. That is right for a typed expense note and wrong for a bank statement,
      where IMPS-...-PARDEEP SHARMA-...-SALARY is exactly a salary payment. The tenant
      rule layer is where that case lives.

   So: tenant rules first (specific, learned, substring, direction-aware), then the
   built-in keywords (broad, shared, word-anchored), then null. Null stays a real answer.
*/

/**
 * Payment rails — the words a bank stamps on a line to say HOW money moved, not what for.
 * Present on nearly every narration, so they must never be what decides a category.
 *
 * Word-bounded deliberately: without the boundaries this would strip "ach" out of the
 * middle of a real merchant name and change what the keyword layer gets to see.
 */
const PAYMENT_RAILS = /\b(neft|rtgs|imps|upi|ach|ecs|inft|mmt)\b/gi;

/** Where a suggestion came from. Both are deterministic; neither is AI. */
export type SuggestionLayer = "tenant-rule" | "builtin-keyword";

export interface CategorySuggestion {
  category: string;
  layer: SuggestionLayer;
  /** Shown to the operator: `rule: PAYUFACEBOOK` or `keyword match`. */
  reason: string;
}

/**
 * The suggestion for one line, from whichever deterministic layer answers first.
 *
 * `keywordFn` is injected rather than imported so this module stays pure and testable
 * without pulling in the queries layer — and so the two layers can be tested apart.
 *
 * Returns null when neither layer knows. The caller MUST render that differently from a
 * category: an uncategorised line showing blank is how a half-done statement reads as
 * finished, which is the same bug the subscription card had on 21 Aug.
 */
export function suggestForLine(
  line: BankLine,
  rules: readonly CategoryRule[],
  keywordFn: (text: string) => string | null,
): CategorySuggestion | null {
  const ruleHit = categoriseByRules(line, rules);
  if (ruleHit) {
    return { category: ruleHit.category, layer: "tenant-rule", reason: ruleHit.reason };
  }

  const text = line.description ?? "";
  if (!text.trim()) return null;

  /* Direction is NOT consulted for the built-in layer, and that is deliberate rather than
     an oversight: those keywords describe what a thing IS ("hosting", "insurance"), not
     which way the money went, and the one direction-sensitive case — salaries — is the one
     it already refuses to answer. */
  const keyword = keywordFn(text);
  if (!keyword) return null;

  /* THE RAIL GUARD, and it was found by a test rather than reasoned about.
     suggestCategory lists "neft" and "rtgs" among its Bank Charges keywords, which is
     correct for a note somebody TYPES — if you write "NEFT" in an expense note you
     usually mean the fee. In a bank narration those words appear on nearly every line,
     because they are the payment RAIL, not the expense. Unguarded, this layer filed
     NEFT-XX9931-QRSTU ENTERPRISES (a Rs 50,000 vendor payment) under Bank Charges, and
     every transfer in the statement with it. That does not look like a bug on screen; it
     looks like a plausible P&L with the wrong number in it.

     The test: strip the rail words and ask again. If the answer evaporates, the match was
     about the rail. If it survives — "NEFT DR-BANK CHARGE FOR RTGS" still says bank
     charge without the rails — it was about the expense, and it stands.

     Accepted cost, stated rather than hidden: a bare "NEFT CHARGES" line now returns null
     instead of Bank Charges, because nothing is left once the rail is removed. That is a
     MISS, and a miss is cheap here — the operator categorises it once and Phase 4 turns
     that into a rule. A wrong answer is the expensive one, because nobody re-checks it. */
  const withoutRails = text.replace(PAYMENT_RAILS, " ");
  if (keywordFn(withoutRails) !== keyword) return null;

  return { category: keyword, layer: "builtin-keyword", reason: "keyword match" };
}

/** Suggest across a batch, keeping the leftovers visible. */
export function suggestBatch<T extends BankLine>(
  lines: readonly T[],
  rules: readonly CategoryRule[],
  keywordFn: (text: string) => string | null,
): { suggestion: CategorySuggestion | null; line: T }[] {
  return lines.map((line) => ({ line, suggestion: suggestForLine(line, rules, keywordFn) }));
}
