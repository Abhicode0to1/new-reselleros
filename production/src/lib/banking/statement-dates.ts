/**
 * Statement dates that are real calendar dates — before they reach the database.
 *
 * Measured 25 Sep 2026: the AI reader returned "2026-21-08" for 21 Aug 2026 (day and
 * month swapped). The shape check passed it, and the import died on Postgres's
 * "date/time field value out of range" with every other row unsaved.
 *
 * ─── A SWAP IS DECIDED FOR THE WHOLE STATEMENT, NOT PER ROW ─────────────────
 * One impossible date ("month 21") proves the reader used day-first for THAT row — and
 * most likely for the rest too, where the swap is invisible ("2026-02-04" read as 4 Feb
 * when it meant 2 Apr). So: if swapping every row gives more real dates than leaving them,
 * every row is swapped. Only when that does not help is a lone impossible row swapped on
 * its own. Anything still impossible is returned as null for the caller to skip and report.
 */

export function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

const swap = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[1]}-${m[3]}-${m[2]}` : iso;
};

export type DateFix = {
  /** Same order as the input; null where no real date could be made. */
  dates: Array<string | null>;
  /** Rows whose day and month were swapped to make a real date. */
  swapped: number;
  /** True when the whole statement was read as day-first and flipped together. */
  swappedAll: boolean;
};

/** Out-of-order steps, ascending or descending — whichever the statement uses. */
function disorder(dates: Array<string | null>): number {
  const d = dates.filter((x): x is string => x !== null);
  let up = 0, down = 0;
  for (let i = 1; i < d.length; i++) {
    if (d[i] < d[i - 1]) up++;
    if (d[i] > d[i - 1]) down++;
  }
  return Math.min(up, down);
}

export function fixStatementDates(input: string[]): DateFix {
  const asIs = input.map((d) => (isRealDate(d) ? d : null));
  const flipped = input.map((d) => (isRealDate(swap(d)) ? swap(d) : null));

  /* Two readings. "Each row" keeps a real date as it is and flips only an impossible one;
     "all flipped" assumes the reader went day-first throughout. Statements are in date
     order, so the reading that keeps them in order wins — flipping every row of a mostly
     correct statement turns 7 Aug into 8 Jul and shows up as dates going backwards. */
  let swapped = 0;
  const eachRow = input.map((_, i) => {
    if (asIs[i]) return asIs[i];
    if (flipped[i]) { swapped++; return flipped[i]; }
    return null;
  });
  const nulls = (ds: Array<string | null>) => ds.filter((x) => x === null).length;

  const [nE, nF] = [nulls(eachRow), nulls(flipped)];
  const [oE, oF] = [disorder(eachRow), disorder(flipped)];
  /* Evidence of a day-first reader: a date impossible as given that becomes real when
     flipped. An impossible-both-ways date ("2026-31-31") is not evidence of anything. */
  const someImpossible = input.some((_, i) => asIs[i] === null && flipped[i] !== null);
  /* Fewer impossible dates wins; then fewer out-of-order steps; on a full tie, an
     impossible date is the evidence that the reader went day-first, so flip them all. */
  const flipAll = nF < nE || (nF === nE && (oF < oE || (oF === oE && someImpossible)));

  if (flipAll) {
    return { dates: flipped, swapped: flipped.filter((d, i) => d && d !== input[i]).length, swappedAll: true };
  }
  return { dates: eachRow, swapped, swappedAll: false };
}
