/**
 * What an irreversible action is about to do, in the operator's words.
 *
 * ─── WHY THIS IS SHARED ─────────────────────────────────────────────────────
 * Three acts in this app cannot be taken back: issuing a tax invoice, sending a quote
 * to a customer, and recording a payment. Each has its own reasons, but two things are
 * identical across all three and were about to be written three times:
 *
 *   - the document-number format, `{PREFIX}-{DOC_CODE}-{YYYY}-{YY}-{NNNN}`, matching
 *     live rows like `INV-TEST-2026-27-0008`;
 *   - the series-gap check, which turns out to matter everywhere. Measured 23 Aug 2026,
 *     ANUTECH holds **zero** invoices with its invoice series at 32, **zero** payments
 *     with its receipt-voucher series at 39, and a quote series at 41. Every counter has
 *     holes, so every one of these dialogs should say so.
 *
 * A fourth act — suspending or cancelling a subscription — is NOT here, because it does
 * not exist as an operator action. The nearest thing, deleting a subscription, already
 * confirms properly (`subscriptions/page.tsx`: what it does, what it is for, and the
 * alternative when it is blocked). Naming a tap that has no button would have been
 * inventing work.
 */

export type ConsequenceTone = "fact" | "warning";

export interface Consequence {
  tone: ConsequenceTone;
  text: string;
}

/** A tenant's counter for one document type, in one financial year. */
export interface SeriesState {
  /** e.g. "INV", "RV", "Q" */
  prefix: string;
  /** The tenant's document code, e.g. "ADPL". Null when never set. */
  docCode: string | null;
  /** e.g. "FY2627" */
  fiscalYear: string;
  /** The last number ISSUED. The next is this + 1. */
  lastNumber: number;
  /** How many documents of this type the books actually hold. */
  documentCount: number;
}

/**
 * `{PREFIX}-{DOC_CODE}-{YYYY}-{YY}-{NNNN}`, matching live data.
 *
 * The doc code is omitted when the tenant has none rather than rendered as "null" —
 * Excel Technologies' row is in exactly that state, and a literal "INV-null-…" on a tax
 * document is worse than a missing segment.
 */
export function formatDocumentNumber(s: SeriesState, n: number): string {
  const fy = /^FY(\d{2})(\d{2})$/.exec(s.fiscalYear);
  const years = fy ? `20${fy[1]}-${fy[2]}` : s.fiscalYear;
  return [s.prefix, s.docCode?.trim() || null, years, String(n).padStart(4, "0")]
    .filter(Boolean)
    .join("-");
}

/**
 * The gap between numbers consumed and documents held, when there is one.
 *
 * Not a rule being broken — a fact the operator is better off seeing before adding to
 * it. A GST series is expected to run sequentially, and a counter sitting well ahead of
 * the books is the first thing an auditor asks about. Returns null when they agree,
 * because a warning that fires on the healthy case is a warning nobody reads.
 *
 * @param noun  what the documents are called here — "invoice", "receipt voucher"
 */
export function seriesGap(s: SeriesState | null, noun: string): Consequence | null {
  if (!s || s.lastNumber <= 0) return null;
  const gap = s.lastNumber - s.documentCount;
  if (gap <= 0) return null;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (s.documentCount === 0) {
    return {
      tone: "warning",
      text: `This series has already used ${plural(s.lastNumber, "number")} but the books hold no ${noun}s — those were issued and later deleted. Numbers 1-${s.lastNumber} stay permanently unaccounted for, and an auditor will ask.`,
    };
  }
  return {
    tone: "warning",
    text: `${plural(gap, "number")} in this series have no ${noun} against them — issued and later deleted. They cannot be reissued.`,
  };
}

/** True when at least one consequence makes the action impossible rather than risky. */
export function isBlocked(list: readonly Consequence[]): boolean {
  return list.some((c) => c.tone === "warning" && /cannot be|nothing can be|no amount/i.test(c.text));
}
