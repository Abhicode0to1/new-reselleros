/**
 * Turn a bank narration into candidate RULE PATTERNS — Phase 4 of
 * docs/AI-CATEGORISATION-PLAN.md, where an operator's correction becomes a rule and the
 * deterministic layer grows.
 *
 * ─── WHY NOT JUST STORE THE NARRATION ───────────────────────────────────────
 * Because a rule made from the whole line matches exactly one line, forever. Every real
 * narration on this account carries a unique transaction reference:
 *
 *   50100784857169-TPT-JULY SALARY-PAWAN
 *   IMPS-518912349366-DARSHAN KUMAR-HDFC-XXXXXXXXXX5456-ANUTECH
 *
 * So "remember this" has to mean "remember the part that repeats". Getting that wrong in
 * either direction is a real cost: too specific and the rule never fires again, too broad
 * and it starts categorising things nobody meant.
 *
 * ─── WHY BOTH SEGMENTS AND SINGLE WORDS ─────────────────────────────────────
 * Measured on the live account. The salary lines are the same payment every month and the
 * bank writes the purpose differently every time:
 *
 *   JULY SALARY  ·  SALARY APR 2026  ·  EMP SALARY MAY  ·  SALARY EMPLOYEE JUNE
 *   SALARY EMP   ·  FULL N FINAL SALARY
 *
 * Not one of those segments repeats. The single word SALARY appears in all fifteen. So
 * segment-only candidates would have produced a rule that fires once and looks broken next
 * month, which is the failure an operator never reports because it is silent.
 *
 * ─── WHY THIS DOES NOT RANK THEM ────────────────────────────────────────────
 * Given "…-JULY SALARY-PAWAN" the useful pattern might be SALARY (all wages) or PAWAN
 * (this person's payments) — and which one is right is a bookkeeping decision, not a
 * property of the string. Ordering by a made-up confidence would dress that up as an
 * answer. Candidates come back in the order they appear in the narration, which is neutral
 * and explainable, and the operator picks. Nothing here writes a rule on its own.
 */

/**
 * Tokens that say HOW money moved, WHICH bank, or WHEN — never what for. Every one of
 * these was read off real narrations on the live account rather than guessed at:
 * TPT/IMPS/NEFT/RTGS as rails, DR/CR as direction, HDFC/ICIC/SBIN/NESF/BKID as the
 * counterparty bank, NETBANK/MUM as netbanking noise, XX as a masked account.
 *
 * Months matter more than they look: "JULY SALARY" would otherwise propose JULY, and a
 * rule on JULY silently stops matching in August and mislabels next July.
 */
const NOISE_TOKENS = new Set([
  // rails and instrument types
  "TPT", "IMPS", "NEFT", "RTGS", "UPI", "ACH", "ECS", "INFT", "MMT", "CHQ", "ATM", "POS",
  // direction markers
  "DR", "CR",
  // counterparty banks / IFSC stems that appear bare
  "HDFC", "ICIC", "SBIN", "NESF", "BKID", "UTIB", "KKBK", "PYTM", "YESB", "IDIB",
  // netbanking and masking noise
  "NETBANK", "MUM", "DEL", "XX", "XXXX",
  // months, long and short
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "JUNE", "JULY", "AUGUST",
  "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
]);

/** Below this, a token is too generic to be a rule on its own. */
const MIN_PATTERN_LENGTH = 4;

/** Upper-cased, single-spaced — the same normalisation categoriseByRules applies. */
function clean(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Is this fragment worth offering?
 *
 * The digit test is the important one. Anything carrying a digit on these narrations is a
 * reference, an account number or a year — 50100784857169, HDFCH01182738271,
 * XXXXXXXXXX5456, "SALARY APR 2026". A rule containing any of them matches one line and
 * then never again.
 */
function isUsable(fragment: string): boolean {
  if (fragment.length < MIN_PATTERN_LENGTH) return false;
  if (/\d/.test(fragment)) return false;
  /* Every word is noise → the whole fragment is noise ("NETBANK, MUM"). A fragment with
     even one real word is kept, because the real word is what the operator wants. */
  const words = fragment.split(" ").filter(Boolean);
  if (words.every((w) => NOISE_TOKENS.has(w))) return false;
  return true;
}

/**
 * Candidate patterns for a narration, most specific (whole segment) to most general
 * (single word), in the order they appear.
 *
 * Returns an EMPTY array when nothing usable can be extracted, which is a real outcome and
 * not a failure to paper over — the caller must then let the operator type a pattern, since
 * a rule they did not mean is worse than a box they have to fill.
 *
 * A narration with no delimiter at all degrades rather than failing:
 * "CU1906914097ANUTECH DIGITAL PVT LTD" loses the token the reference is glued to and
 * offers only DIGITAL — broad, likely not what anyone wants, but a real token the operator
 * can see and decline. That is deliberate; a weak visible candidate beats silence on a line
 * where something IS extractable.
 */
export function proposePatterns(description: string | null, limit = 5): string[] {
  const text = clean(description ?? "");
  if (!text) return [];

  /* Split on the delimiters these banks actually use: hyphen, slash, comma, colon. */
  const segments = text.split(/[-/,:]+/).map((s) => s.trim()).filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const c = clean(candidate);
    if (!isUsable(c) || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };

  /* Segments first — "ACCOUNTING SOFTWARE", "DARSHAN KUMAR", "BILLDKPLAYSTOREGOOGL". */
  for (const segment of segments) add(segment);

  /* Then the individual words inside them, which is where SALARY comes from. */
  for (const segment of segments) {
    const words = segment.split(" ").filter(Boolean);
    if (words.length < 2) continue;   // already offered whole
    for (const word of words) if (!NOISE_TOKENS.has(word)) add(word);
  }

  return out.slice(0, limit);
}

/**
 * Would this pattern have matched the line it came from? A sanity check the UI can run
 * before saving, so a pattern that cannot even match its own example never reaches the
 * table. Cheap, and it catches a whole class of typo in a hand-typed pattern.
 */
export function patternMatchesLine(pattern: string, description: string | null): boolean {
  const p = clean(pattern);
  if (!p) return false;
  return clean(description ?? "").includes(p);
}
