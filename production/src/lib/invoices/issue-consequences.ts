/**
 * What becomes irreversible when an invoice is issued, in the operator's words.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Issuing a GST tax invoice was a single unconfirmed click. `/invoices` had a
 * "Generate" button wired straight to `generateInvoice.mutate(q.id)`, and a BULK
 * action that looped it over every selected quote — so one click could burn a run
 * of serial numbers. Nothing on screen said what the click did.
 *
 * Two things make that worse than it looks:
 *
 *   1. Since 20260823090000 an issued invoice genuinely CANNOT be edited. Before
 *      that guard the click was recoverable by a quiet UPDATE; now the only
 *      correction is a credit note plus a fresh invoice (CGST Section 34). The
 *      screen must say so before the click, not after.
 *   2. The serial number is consumed and never reused. `invoice_delete_no_serial_reuse`
 *      (migration 0118) retires a deleted invoice's number, because CGST Rule 46
 *      forbids two supplies sharing one. So a mistaken issue leaves a permanent hole.
 *
 * ─── AND IT SHOWS THE NUMBER, WHICH IS ITS OWN ALARM ────────────────────────
 * Measured 23 Aug 2026: ANUTECH has **zero** invoices and its FY2627 series sits at
 * **32**. Thirty-two numbers consumed, every one of those invoices since deleted. An
 * operator who has never issued an invoice, shown "this will take
 * INV-ADPL-2026-27-0033", learns something no summary would have told them. That is
 * the point of naming the number rather than saying "a number will be used".
 *
 * Pure and display-only: it decides nothing and writes nothing. `next_document_number`
 * remains the only thing that allocates, so the predicted number is a PREDICTION —
 * a concurrent issue can take it first, and `predictedIsCertain` says as much.
 */
import { rupee } from "@/lib/utils";

export interface SeriesState {
  /** e.g. "INV" */
  prefix: string;
  /** The tenant's document code, e.g. "ADPL". Null when never set. */
  docCode: string | null;
  /** e.g. "FY2627" */
  fiscalYear: string;
  /** The last number ISSUED. The next one is this + 1. */
  lastNumber: number;
  /** How many invoices this tenant actually holds — for the gap check below. */
  invoiceCount: number;
}

export interface QuoteToInvoice {
  id: string;
  customerName: string | null;
  /** Whole rupees (CLAUDE.md §13). */
  amount: number | null;
  /** Net-30 fallback applies when the quote carries none — see 20260822190000. */
  paymentTermsDays: number | null;
}

export type ConsequenceTone = "fact" | "warning";

export interface Consequence {
  tone: ConsequenceTone;
  text: string;
}

export interface IssueConsequences {
  /** The number this will most likely take, e.g. "INV-ADPL-2026-27-0033". */
  predictedNumber: string;
  /**
   * False when the prediction could be wrong — the series row is missing, so the
   * number is being guessed rather than read. Never claim certainty this cannot have.
   */
  predictedIsCertain: boolean;
  /** Ordered most-consequential first. */
  consequences: Consequence[];
}

/**
 * `{PREFIX}-{DOC_CODE}-{YYYY}-{YY}-{NNNN}`, matching live data
 * (`INV-TEST-2026-27-0008`). The doc code is omitted when the tenant has none, which
 * is the shape Excel Technologies' row is in.
 */
export function formatDocumentNumber(s: SeriesState, n: number): string {
  const fy = /^FY(\d{2})(\d{2})$/.exec(s.fiscalYear);
  const years = fy ? `20${fy[1]}-${fy[2]}` : s.fiscalYear;
  const parts = [s.prefix, s.docCode?.trim() || null, years, String(n).padStart(4, "0")];
  return parts.filter(Boolean).join("-");
}

export function issueConsequences(args: {
  quote: QuoteToInvoice;
  /** Null when the tenant has no series row yet — the first invoice of the year. */
  series: SeriesState | null;
}): IssueConsequences {
  const { quote, series } = args;
  const out: Consequence[] = [];

  const next = (series?.lastNumber ?? 0) + 1;
  const predictedNumber = series
    ? formatDocumentNumber(series, next)
    : `${quote.id} → the first invoice of this financial year`;

  /* Most consequential first, because this is read in a hurry. The two facts that
     were not on screen at all before are the two at the top. */
  out.push({
    tone: "fact",
    text: series
      ? `Takes invoice number ${predictedNumber}. That number is used up either way — deleting the invoice later retires it rather than freeing it.`
      : `This is the first invoice of the financial year for this business, so it opens the series.`,
  });

  out.push({
    tone: "fact",
    text: "Once issued it cannot be edited. Correcting a mistake means a credit note plus a fresh invoice, not a change to this one.",
  });

  if (quote.amount !== null && quote.amount > 0) {
    out.push({
      tone: "fact",
      text: `${rupee(quote.amount)} becomes payable${quote.customerName ? ` by ${quote.customerName}` : ""}, on a document you cannot alter afterwards.`,
    });
  } else {
    /* generate_invoice refuses a ₹0 quote (#26), so this is a block, not a caveat. */
    out.push({
      tone: "warning",
      text: "This quote has no amount, so no invoice can be issued from it. Set the quote total first.",
    });
  }

  /* Payment terms. The net-30 fallback landed on 22 Aug 2026; before it, a quote with
     no terms produced an invoice due the day it was issued, and the dunning cron began
     chasing the next morning. Worth stating which of the two applies. */
  if (quote.paymentTermsDays === null) {
    out.push({
      tone: "fact",
      text: "The quote carries no payment terms, so the invoice falls due 30 days from today.",
    });
  } else if (quote.paymentTermsDays <= 0) {
    out.push({
      tone: "warning",
      text: "The quote's payment terms are 0 days, so this invoice is due the moment it is issued and will be chased as overdue tomorrow.",
    });
  } else {
    out.push({
      tone: "fact",
      text: `Falls due in ${quote.paymentTermsDays} days, from the quote's own payment terms.`,
    });
  }

  /* The series-gap alarm. Not a rule being broken — a fact the operator is better off
     seeing before they add to it. A live GST series is expected to be sequential, and a
     tenant sitting at 32 with nothing on the books invites the question at audit. */
  if (series && series.lastNumber > 0 && series.invoiceCount === 0) {
    out.push({
      tone: "warning",
      text: `This series has already used ${series.lastNumber} number${series.lastNumber === 1 ? "" : "s"} but the books hold no invoices — those were issued and deleted. Numbers 1-${series.lastNumber} stay permanently unaccounted for, and an auditor will ask.`,
    });
  } else if (series && series.lastNumber > series.invoiceCount) {
    const gap = series.lastNumber - series.invoiceCount;
    out.push({
      tone: "warning",
      text: `${gap} number${gap === 1 ? "" : "s"} in this series have no invoice against them — issued and later deleted. They cannot be reissued.`,
    });
  }

  return {
    predictedNumber,
    predictedIsCertain: series !== null,
    consequences: out,
  };
}

/**
 * The same question for a BULK issue, which is the one that can do real damage: the
 * old bulk button looped `generateInvoice` over every selected quote with no
 * confirmation at all, so one click could consume a run of numbers.
 */
export function bulkIssueConsequences(args: {
  quotes: readonly QuoteToInvoice[];
  series: SeriesState | null;
}): IssueConsequences {
  const { quotes, series } = args;
  const n = quotes.length;
  const total = quotes.reduce((s, q) => s + (q.amount ?? 0), 0);

  const first = (series?.lastNumber ?? 0) + 1;
  const last = first + Math.max(0, n - 1);
  const range = series
    ? n === 1
      ? formatDocumentNumber(series, first)
      : `${formatDocumentNumber(series, first)} … ${formatDocumentNumber(series, last)}`
    : "the first numbers of this financial year";

  const out: Consequence[] = [
    {
      tone: "fact",
      text: `Issues ${n} invoice${n === 1 ? "" : "s"} and uses ${n === 1 ? "number" : "numbers"} ${range}.`,
    },
    {
      tone: "fact",
      text: "None of them can be edited afterwards. Each mistake needs its own credit note.",
    },
    {
      tone: total > 0 ? "fact" : "warning",
      text: total > 0
        ? `${rupee(total)} becomes payable across ${n} customer document${n === 1 ? "" : "s"}.`
        : "None of the selected quotes carries an amount, so nothing can be issued.",
    },
  ];

  /* The bulk path is partial-failure-prone: the old loop counted ok/fail and carried
     on, so a run could stop halfway with numbers already consumed. Saying so is the
     difference between "it failed" and "it half-succeeded and you now have gaps". */
  if (n > 1) {
    out.push({
      tone: "warning",
      text: "These are issued one at a time. If one fails partway, the invoices before it are already issued and their numbers already used.",
    });
  }

  return { predictedNumber: range, predictedIsCertain: series !== null, consequences: out };
}
