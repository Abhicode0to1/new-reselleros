/**
 * Does the account's computed "Balance in bank" agree with what the bank statement
 * itself says — and if not, why?
 *
 * Every imported line carries the bank's running balance (balance_after). The app's
 * figure is opening_balance + Σ(credit − debit). The two disagree for exactly two
 * reasons, and this names both, with amounts:
 *   1. the opening balance is not the balance before the first imported line;
 *   2. lines are missing between two dates — the running balance jumps by more than
 *      the lines in between explain.
 *
 * ─── ORDER WITHIN A DAY IS NOT TRUSTED ──────────────────────────────────────
 * Lines of one day may be stored in any order. Each day is re-threaded by the chain
 * itself (a line follows the one whose balance it starts from), so four salaries paid
 * on one date never read as a gap. Only day totals are compared across days, and a
 * gap is reported between two dates — never pinned to a line it cannot be sure of.
 */

export type StatementLine = {
  txn_date: string;
  debit: number;
  credit: number;
  balance_after: number | null;
};

export type StatementGap = {
  /** Last date the statement agreed with the lines (exclusive). */
  after: string;
  /** Date by which the difference shows (inclusive). */
  by: string;
  /** Positive = money OUT missing from the app; negative = money IN missing. */
  amount: number;
};

export type StatementCheck = {
  statementBalance: number;
  statementDate: string;
  appBalance: number;
  /** app − statement */
  difference: number;
  /** The balance just before the first imported line, per the statement. */
  impliedOpening: number;
  firstLineDate: string;
  /** How far the account's opening balance is from impliedOpening (account − implied). */
  openingDifference: number;
  gaps: StatementGap[];
};

const TOLERANCE = 1;   // whole rupees; statements carry paise
const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const startOf = (l: StatementLine) => (l.balance_after as number) + l.debit - l.credit;

/**
 * The day's lines in chain order starting from `start`, as far as the chain goes.
 * Returns the ordered part and whatever could not be threaded.
 */
function thread(start: number, lines: StatementLine[]): { chained: StatementLine[]; rest: StatementLine[] } {
  const rest = [...lines];
  const chained: StatementLine[] = [];
  let cur = start;
  for (;;) {
    const i = rest.findIndex((l) => close(startOf(l), cur));
    if (i < 0) break;
    const [l] = rest.splice(i, 1);
    chained.push(l);
    cur = l.balance_after as number;
  }
  return { chained, rest };
}

/** A day's own closing balance: the line no other line of that day continues from. */
function dayEnd(lines: StatementLine[]): number {
  const ends = lines.filter((l) => !lines.some((o) => o !== l && close(startOf(o), l.balance_after as number)));
  return (ends.length === 1 ? ends[0] : lines[lines.length - 1]).balance_after as number;
}

/** A day's own opening balance: the start no other line of that day ends on. */
function dayStart(lines: StatementLine[]): number {
  const starts = lines.filter((l) => !lines.some((o) => o !== l && close(o.balance_after as number, startOf(l))));
  return startOf(starts.length === 1 ? starts[0] : lines[0]);
}

export function checkStatement(lines: StatementLine[], openingBalance: number): StatementCheck | null {
  const withBal = lines.filter((l) => l.balance_after !== null);
  /* Without the bank's own running balance there is nothing to check against — say
     nothing rather than something made up. */
  if (withBal.length === 0 || withBal.length !== lines.length) return null;

  const byDay = new Map<string, StatementLine[]>();
  for (const l of lines) byDay.set(l.txn_date, [...(byDay.get(l.txn_date) ?? []), l]);
  const days = [...byDay.keys()].sort();

  const impliedOpening = dayStart(byDay.get(days[0])!);
  const appBalance = openingBalance + lines.reduce((s, l) => s + l.credit - l.debit, 0);

  const gaps: StatementGap[] = [];
  let cur = impliedOpening;
  let lastGood = "";
  for (const d of days) {
    const dayLines = byDay.get(d)!;
    const { rest } = thread(cur, dayLines);
    const net = dayLines.reduce((s, l) => s + l.credit - l.debit, 0);
    if (rest.length === 0) {
      cur += net;
      lastGood = d;
      continue;
    }
    /* The chain broke: something happened that these lines do not show. Measure it at
       the day's end, then carry on from the statement's own figure. */
    const end = dayEnd(dayLines);
    const expected = cur + net;
    if (!close(expected, end)) gaps.push({ after: lastGood || d, by: d, amount: expected - end });
    cur = end;
    lastGood = d;
  }

  /* When lines are missing INSIDE a day, that day's true closing balance is unknowable,
     so the shortfall can show as −X on one date and +Y on the next. Adjacent gaps of
     opposite sign are one hole seen twice: report them as one window with their sum. */
  const merged: StatementGap[] = [];
  for (const g of gaps) {
    const prev = merged[merged.length - 1];
    if (prev && prev.by === g.after && Math.sign(prev.amount) !== Math.sign(g.amount)) {
      prev.by = g.by;
      prev.amount += g.amount;
    } else {
      merged.push({ ...g });
    }
  }
  const realGaps = merged.filter((g) => !close(g.amount, 0));

  const lastDay = byDay.get(days[days.length - 1])!;
  const statementBalance = dayEnd(lastDay);
  return {
    statementBalance,
    statementDate: days[days.length - 1],
    appBalance,
    difference: appBalance - statementBalance,
    impliedOpening,
    firstLineDate: days[0],
    openingDifference: openingBalance - impliedOpening,
    gaps: realGaps,
  };
}
