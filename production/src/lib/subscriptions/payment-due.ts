/**
 * The postpaid countdown — "26 days left" / "Due today" / "5 days overdue".
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * "Postpaid / Credit Terms" activates a subscription and books the whole
 * GST-inclusive balance as owed, and nothing on any screen said when that money was
 * expected. The reminder ladder the app already owns (pre-due nudge, day 1/3/7/14,
 * grace warning, final notice) hangs off an INVOICE due date, and this path raises no
 * invoice — the owner's decision, because a tax invoice creates a GST liability on
 * money that sometimes never arrives.
 *
 * So the date sits on the subscription and this decides what to show for it. One
 * function, used by /subscriptions and /payments, because two screens computing
 * "overdue" separately is two screens that will eventually disagree about the same
 * customer.
 *
 * ─── WHOLE DAYS, IST, NO CLOCK ARITHMETIC ───────────────────────────────────
 * Both dates are plain YYYY-MM-DD calendar dates, so they are compared as dates and
 * never as timestamps. Subtracting Date objects would drag the browser's timezone in
 * and make "due today" flip a day early for anyone west of IST — which for an Indian
 * reseller means it reads wrong for exactly nobody, right up until someone opens the
 * app on a trip and it does.
 */

export type PaymentDueKind =
  /** No agreed date — prepaid, or a row that predates the column. Show nothing. */
  | "none"
  /** More than `AMBER_WITHIN_DAYS` away. Quiet. */
  | "upcoming"
  /** Inside the last few days. Worth noticing. */
  | "due_soon"
  /** Today is the day. */
  | "due_today"
  /** Past it. Loud, and the row gets highlighted. */
  | "overdue";

export interface PaymentDueState {
  kind: PaymentDueKind;
  /** Whole days until the due date. Negative once it has passed. 0 = today. */
  days: number;
  /** Ready to render: "26 days left", "Due today", "5 days overdue". */
  label: string;
  /** True when the whole row should be highlighted, not just the chip. */
  highlight: boolean;
}

/** Inside this many days the chip turns amber. Three working-ish days of warning. */
export const AMBER_WITHIN_DAYS = 3;

/** Whole days from `from` to `to`, both YYYY-MM-DD. Calendar days, not elapsed time. */
export function wholeDaysUntil(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(
    Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Pluralise without pulling in a library for one word. */
const dayWord = (n: number) => (n === 1 ? "day" : "days");

/**
 * What to show for a subscription's payment due date.
 *
 * `dueDate` null/empty → `none`, and the caller renders nothing. A balance with no
 * agreed date is not overdue; it is unrecorded, and dressing it up as late would put a
 * red row against a customer who never agreed to a date.
 *
 * `outstanding` of 0 or less → also `none`. A paid-off subscription keeps its due date
 * on the record, and a countdown against a settled balance is noise that trains the
 * operator to ignore the colour.
 */
export function paymentDueState(
  dueDate: string | null | undefined,
  today: string,
  outstanding: number,
): PaymentDueState {
  if (!dueDate || outstanding <= 0) {
    return { kind: "none", days: 0, label: "", highlight: false };
  }
  const days = wholeDaysUntil(today, dueDate.slice(0, 10));

  if (days < 0) {
    const late = Math.abs(days);
    return {
      kind: "overdue", days,
      label: `${late} ${dayWord(late)} overdue`,
      /* The only state that highlights the row. It stays highlighted for as long as the
         balance is owed — an overdue credit sale that fades back into the list is the
         problem this whole feature exists to fix. */
      highlight: true,
    };
  }
  if (days === 0) return { kind: "due_today", days, label: "Due today", highlight: false };
  if (days <= AMBER_WITHIN_DAYS) {
    return { kind: "due_soon", days, label: `${days} ${dayWord(days)} left`, highlight: false };
  }
  return { kind: "upcoming", days, label: `${days} ${dayWord(days)} left`, highlight: false };
}

/** Today in IST as YYYY-MM-DD. The business runs on IST; the browser may not. */
export function todayIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * The chip text — which must say WHAT is due, not just when.
 *
 * Reported 11 Sep 2026: the chip read "4 days left · 15 Sept 2026" and nothing on it
 * said the days were about MONEY. The subscription row carries a renewal date in the
 * next column and a term in the one after, so a bare countdown beside them reads as
 * another lifecycle date rather than an unpaid bill.
 *
 * One function, used by /subscriptions and /payments, because the same balance
 * described two ways on two screens is the operator's problem to reconcile.
 *
 * `formattedDate` is passed in rather than formatted here: date formatting lives in
 * lib/utils (DD MMM YYYY, IST — CLAUDE.md §13) and this module deliberately has no
 * dependency on it.
 */
export function paymentDueChipLabel(
  state: PaymentDueState, formattedDate: string,
): string {
  switch (state.kind) {
    case "none":
      /* Money owed with no agreed date. Named, not blank — a silent row is the thing
         this whole feature exists to prevent. */
      return "No payment due date";
    case "overdue":
      /* "Payment 5 days overdue" — the noun first, so it cannot be read as a renewal. */
      return `Payment ${state.label}`;
    case "due_today":
      return `Payment due today · ${formattedDate}`;
    default:
      /* "Pay by 15 Sept 2026 · 4 days left" — the instruction, the date, then the
         urgency. Reading only the first two words still tells the operator what it is. */
      return `Pay by ${formattedDate} · ${state.label}`;
  }
}
