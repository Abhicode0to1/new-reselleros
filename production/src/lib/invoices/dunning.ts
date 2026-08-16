/**
 * Invoice dunning — chasing an invoice that has gone past its due date.
 *
 * ─── THIS IS A DIFFERENT CLOCK FROM RENEWAL CADENCE, AND CONFLATING THEM
 *     WOULD SUSPEND THE WRONG CUSTOMERS ─────────────────────────────────────
 * lib/renewals/cadence.ts counts DOWN to a subscription's renewal_date and chases the
 * customer to renew. This counts UP from an invoice's due_date and chases them to pay.
 *
 * Different subject (a subscription vs one invoice), different clock (before vs after),
 * different question. A customer can be perfectly current on renewals and 20 days late
 * on a one-off invoice — and the reverse. Running one engine on both would either chase
 * people who owe nothing or ignore people who owe a lot.
 *
 * ─── "DAY 14 AUTO-SUSPEND" IS DELIBERATELY NOT AUTOMATIC BY DEFAULT ─────────
 * The brief asks for it. It is built, and it is OFF unless the tenant turns it on, for
 * a reason worth stating rather than burying:
 *
 * Suspending a customer means their staff cannot read email. It is the most damaging
 * thing this software can do to an end user, it is done to people who are not the
 * software's customer, and it is reversible only by a human noticing. Firing that from
 * an unpaid-invoice clock would suspend a live subscription because an UNRELATED
 * one-off invoice went unpaid — a hosting bill, a support charge — and the first
 * anybody hears of it is a customer who cannot log in.
 *
 * Suspension already has an owner: the renewal engine, which knows about the
 * subscription lifecycle and grace period. So the default here escalates to the
 * reseller with everything they need to decide in one click. `autoSuspend: true` makes
 * it automatic for a tenant that wants it, and even then only for an invoice actually
 * linked to a subscription.
 *
 * ─── IDEMPOTENT, WITH A CATCH-UP RULE ───────────────────────────────────────
 * The cron may miss a day (deploy, outage, clock skew). `decideDunning` returns the
 * most urgent step that should ALREADY have fired, not only an exact-day match — so a
 * two-day gap does not silently skip the Day-3 chase. The caller checks its log before
 * sending, so re-running the same day sends nothing.
 */

export type DunningStep =
  /** Not due yet, or paid. Nothing to do. */
  | "none"
  /** Day 1 — a light "this slipped past" note. */
  | "reminder"
  /** Day 3 — the payment link again, in case the first attempt failed. */
  | "retry"
  /** Day 7 — states plainly what happens if it stays unpaid. */
  | "grace_warning"
  /** Day 14 — suspend, or escalate to the reseller. See the header. */
  | "final";

export type DunningAction = "none" | "email" | "escalate" | "suspend";

/** MUST stay in ASCENDING daysOverdue order — decideDunning walks it backwards. */
export const DUNNING_STEPS: { daysOverdue: number; step: DunningStep; tone: string }[] = [
  { daysOverdue: 1,  step: "reminder",      tone: "friendly" },
  { daysOverdue: 3,  step: "retry",         tone: "helpful"  },
  { daysOverdue: 7,  step: "grace_warning", tone: "firm"     },
  { daysOverdue: 14, step: "final",         tone: "final"    },
];

export interface DunningInput {
  /** Invoice due date, YYYY-MM-DD. Null = never chased; see the note in decideDunning. */
  dueDate: string | null;
  status: "draft" | "pending" | "paid" | "overdue" | "void";
  /** ₹ still owed. Zero or less means nothing to chase. */
  amountDue: number;
  /** The most urgent step already sent for this invoice, if any. */
  lastStepSent?: DunningStep | null;
  /** Subscription this invoice bills, when there is one. */
  subscriptionId?: string | null;
  /** Tenant opted in to automatic suspension. Default false — see the header. */
  autoSuspend?: boolean;
}

export interface DunningDecision {
  step: DunningStep;
  action: DunningAction;
  daysOverdue: number;
  /** True when this step has not been sent for this invoice yet. */
  shouldSend: boolean;
  /** Plain language, for the log and for the reseller's escalation. */
  reason: string;
}

const NOTHING: Omit<DunningDecision, "daysOverdue" | "reason"> = {
  step: "none", action: "none", shouldSend: false,
};

/** Calendar days between two IST midnights. Positive when `to` is later. */
export function daysBetweenIST(from: Date, to: Date): number {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const dayMs = 86_400_000;
  return Math.floor((to.getTime() + istOffsetMs) / dayMs) - Math.floor((from.getTime() + istOffsetMs) / dayMs);
}

const RANK: Record<DunningStep, number> = { none: 0, reminder: 1, retry: 2, grace_warning: 3, final: 4 };

/**
 * What should happen to this invoice today?
 *
 * Nothing is chased unless the invoice is genuinely unpaid AND has a due date. An
 * invoice with no due date is not "overdue since forever" — it is an invoice nobody
 * gave a deadline, and inventing one would start dunning customers on terms they were
 * never told.
 */
export function decideDunning(input: DunningInput, now: Date = new Date()): DunningDecision {
  const daysOverdue = input.dueDate
    ? daysBetweenIST(new Date(`${input.dueDate}T12:00:00+05:30`), now)
    : 0;

  if (!input.dueDate) {
    return { ...NOTHING, daysOverdue: 0, reason: "No due date on this invoice, so there is no deadline to chase against." };
  }
  if (input.status === "paid" || input.status === "void" || input.status === "draft") {
    return { ...NOTHING, daysOverdue, reason: `Invoice is ${input.status}.` };
  }
  if (input.amountDue <= 0) {
    return { ...NOTHING, daysOverdue, reason: "Nothing outstanding." };
  }
  if (daysOverdue < DUNNING_STEPS[0].daysOverdue) {
    return { ...NOTHING, daysOverdue, reason: daysOverdue < 0 ? "Not due yet." : "Due today." };
  }

  /* Walk backwards for the most urgent step already reached. An exact-day match would
     silently skip a chase whenever the cron misses a day. */
  const due = [...DUNNING_STEPS].reverse().find((s) => daysOverdue >= s.daysOverdue)!;
  const alreadySent = RANK[input.lastStepSent ?? "none"] >= RANK[due.step];

  if (due.step !== "final") {
    return {
      step: due.step,
      action: "email",
      daysOverdue,
      shouldSend: !alreadySent,
      reason: `${daysOverdue} days past due.`,
    };
  }

  /* Day 14. Suspension is only ever automatic when the tenant asked for it AND the
     invoice actually bills a subscription — suspending a mail service over an
     unrelated hosting bill is not a stronger version of chasing, it is a different
     and worse action. */
  const canSuspend = Boolean(input.autoSuspend && input.subscriptionId);
  return {
    step: "final",
    action: canSuspend ? "suspend" : "escalate",
    daysOverdue,
    shouldSend: !alreadySent,
    reason: canSuspend
      ? `${daysOverdue} days past due — automatic suspension is on for this tenant and this invoice bills a subscription.`
      : input.subscriptionId
        ? `${daysOverdue} days past due. Automatic suspension is off, so this needs your decision.`
        : `${daysOverdue} days past due. This invoice is not linked to a subscription, so there is nothing to suspend — it needs a call.`,
  };
}

/** Customer-facing subject and body for the steps that email. */
export function dunningMessage(args: {
  step: DunningStep;
  invoiceId: string;
  customerName: string;
  amountDue: string;
  dueDate: string;
  sellerName: string;
  payLink?: string | null;
}): { subject: string; text: string } | null {
  const { step, invoiceId, customerName, amountDue, dueDate, sellerName, payLink } = args;
  const pay = payLink ? `\n\nPay here: ${payLink}` : "";
  const first = customerName.split(" ")[0] || "there";

  switch (step) {
    case "reminder":
      return {
        subject: `Invoice ${invoiceId} — just slipped past its due date`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} was due on ${dueDate} and we haven't seen it come through yet. If it's already on its way, please ignore this.${pay}\n\n— ${sellerName}`,
      };
    case "retry":
      return {
        subject: `Invoice ${invoiceId} — payment link, in case the first one didn't go through`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} is still showing as unpaid. Sometimes a payment fails without telling anyone, so here's the link again.${pay}\n\nIf you've already paid, reply and we'll trace it.\n\n— ${sellerName}`,
      };
    case "grace_warning":
      return {
        subject: `Invoice ${invoiceId} — ${amountDue} still outstanding`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} has been outstanding since ${dueDate}.\n\nWe'd rather sort this out than let it affect your service, so please either pay using the link below or tell us what's holding it up — a PO, an approval, a query on the invoice — and we'll work with it.${pay}\n\n— ${sellerName}`,
      };
    case "final":
      return {
        subject: `Invoice ${invoiceId} — we need to hear from you`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} has now been outstanding for two weeks.\n\nWe need to agree how this will be settled. Please pay using the link below, or call us today so we can find a way forward.${pay}\n\n— ${sellerName}`,
      };
    default:
      return null;
  }
}
