/**
 * UPI Autopay / e-NACH mandates — the rules around a standing permission to debit.
 *
 * ─── A MANDATE IS A LEGAL AUTHORISATION, NOT A SETTING ──────────────────────
 * "Autopay is on" means a customer's bank will move money without anyone touching
 * it. Everything in this module follows from that one fact:
 *
 *   • `active` is reachable ONLY from a gateway event. No button, no admin action
 *     and no import can set it. If the app could mark a mandate active, a reseller
 *     would stop chasing a renewal that is never going to collect — the worst
 *     possible version of this feature.
 *   • Every other state is a state the gateway told us about, or one we asked the
 *     gateway for and are waiting on.
 *   • Cancelling is allowed from the app, because withdrawing permission must never
 *     depend on a webhook arriving.
 *
 * ─── THE TRAP THAT MAKES AUTOPAY FAIL SILENTLY: THE CAP ─────────────────────
 * A UPI Autopay mandate authorises up to a MAXIMUM AMOUNT per debit. It is fixed
 * when the customer approves it and cannot be raised afterwards — a higher amount
 * needs a new mandate the customer approves again.
 *
 * So a subscription that grows past the cap stops collecting. Nothing errors on our
 * side; the debit is simply declined, and the first anyone notices is an unpaid
 * renewal that everybody assumed was automatic. `mandateHeadroom` exists to catch
 * that before it happens, and `MANDATE_HEADROOM_MULTIPLIER` is why a mandate is
 * requested for more than today's bill.
 *
 * ─── THE PER-DEBIT CEILING IS A BUSINESS PARAMETER, NOT A FACT I INVENTED ───
 * NPCI caps UPI Autopay per-debit amounts, and the ceiling depends on the merchant
 * category and on whether additional authentication is used. `MAX_MANDATE_AMOUNT`
 * below is a conservative default so the app refuses early with a readable message
 * instead of letting the gateway reject a mandate the customer already tried to
 * approve. CONFIRM the real figure with Razorpay for this account before raising it
 * — a number guessed here would either block legitimate mandates or promise ones
 * that cannot be authorised.
 */

/**
 * The states a mandate ROW can hold. These are the five values in the Postgres enum.
 */
export type StoredMandateStatus =
  /** Created at the gateway; the customer has not approved it yet. */
  | "pending_authorisation"
  /** The gateway confirmed the customer approved it. Only a webhook sets this. */
  | "active"
  /** The gateway stopped it — usually repeated debit failures. */
  | "paused"
  /** Withdrawn, by the customer or by us. Terminal. */
  | "cancelled"
  /** Past its end date. Terminal. */
  | "expired";

/**
 * What the APP reasons about, which is one more thing than the database stores:
 * "none" means no mandate row exists at all.
 *
 * Kept as a separate type rather than a sixth enum value because a row can never BE
 * "none" — the absence of a row is not a state a row is in. Conflating them is what
 * made the webhook's update typecheck against a value Postgres would reject.
 */
export type MandateStatus = StoredMandateStatus | "none";

export type MandateMethod = "upi" | "emandate" | "card";

/**
 * ₹ ceiling this app will request per debit. Conservative on purpose — see the
 * header. Raising it is a business decision that needs confirming with Razorpay.
 */
export const MAX_MANDATE_AMOUNT = 15_000;

/**
 * A mandate is requested for this multiple of today's bill.
 *
 * Seats get added mid-term. A mandate authorised for exactly today's amount stops
 * collecting the first time a customer grows, and the cap cannot be raised without
 * asking them to approve a new one. Two times leaves room for ordinary growth
 * without asking for a number that makes a customer hesitate at the approval screen.
 */
export const MANDATE_HEADROOM_MULTIPLIER = 2;

export interface MandateFacts {
  status: MandateStatus;
  /** ₹ the mandate is authorised for, per debit. Null until the gateway confirms. */
  maxAmount: number | null;
  /** YYYY-MM-DD the mandate stops being valid. Null = open-ended. */
  endDate?: string | null;
  /** Today, YYYY-MM-DD (IST). */
  today: string;
}

/** Can this mandate actually collect money right now? */
export function canCollect(f: MandateFacts): boolean {
  if (f.status !== "active") return false;
  if (f.endDate && f.endDate < f.today) return false;
  return true;
}

export type MandateGate =
  | { allowed: true; requestAmount: number }
  | { allowed: false; reason: string; nextStep: string };

/**
 * May we ask this customer to set up autopay, and for how much?
 *
 * The requested amount is today's bill with headroom, capped. Refusals name what to
 * do instead — a customer who cannot use autopay still has to pay somehow (§24).
 */
export function planMandate(args: {
  current: MandateStatus;
  /** ₹ the customer is billed per cycle today, INCLUDING GST — that is what gets debited. */
  cycleAmount: number;
}): MandateGate {
  const { current, cycleAmount } = args;

  if (current === "active") {
    return {
      allowed: false,
      reason: "Autopay is already set up on this subscription.",
      nextStep: "Nothing to do. Cancel it first if the amount or the account needs to change.",
    };
  }
  if (current === "pending_authorisation") {
    return {
      allowed: false,
      reason: "An autopay request is already waiting for approval.",
      nextStep: "Open the approval link that was sent, or cancel the pending request and start again.",
    };
  }
  if (!Number.isFinite(cycleAmount) || cycleAmount <= 0) {
    return {
      allowed: false,
      reason: "There is nothing to collect on this subscription yet.",
      nextStep: "Set it up once the first invoice amount is known.",
    };
  }

  const withHeadroom = Math.ceil(cycleAmount * MANDATE_HEADROOM_MULTIPLIER);

  if (cycleAmount > MAX_MANDATE_AMOUNT) {
    /* Refused BEFORE the customer is sent to approve something the gateway will
       reject — being turned away at a bank's approval screen is a far worse
       experience than being told here. */
    return {
      allowed: false,
      reason: `This bill is ₹${cycleAmount.toLocaleString("en-IN")}, above the ₹${MAX_MANDATE_AMOUNT.toLocaleString("en-IN")} per-debit limit for autopay.`,
      nextStep: "Collect this one by UPI or bank transfer each cycle, or split the billing into smaller instalments.",
    };
  }

  return { allowed: true, requestAmount: Math.min(withHeadroom, MAX_MANDATE_AMOUNT) };
}

export interface Headroom {
  /** ₹ left under the cap for this debit. Negative when the bill has outgrown it. */
  remaining: number;
  /** True when the next debit would exceed the mandate and fail. */
  willFail: boolean;
  /** True when it still fits but is close enough to warn about. */
  tight: boolean;
  message: string;
}

/**
 * Will the next debit fit under the mandate?
 *
 * This is the check that stops autopay failing silently. A mandate's cap cannot be
 * raised, so the answer to "it no longer fits" is always a NEW mandate the customer
 * approves — and the time to find that out is before the debit, not after.
 */
export function mandateHeadroom(args: {
  maxAmount: number | null;
  /** ₹ about to be debited, including GST. */
  nextDebit: number;
}): Headroom {
  const { maxAmount, nextDebit } = args;

  if (maxAmount == null) {
    return {
      remaining: 0, willFail: false, tight: false,
      message: "No mandate amount recorded, so there is nothing to check against.",
    };
  }

  const remaining = maxAmount - nextDebit;
  if (remaining < 0) {
    return {
      remaining, willFail: true, tight: false,
      message: `The next bill of ₹${nextDebit.toLocaleString("en-IN")} is more than the ₹${maxAmount.toLocaleString("en-IN")} autopay was approved for. It will be declined — a mandate's limit cannot be raised, so the customer has to approve a new one.`,
    };
  }
  /* Within 20% of the cap. Chosen so one ordinary seat addition does not take a
     subscription straight from "fine" to "declined" with no warning in between. */
  const tight = remaining < maxAmount * 0.2;
  return {
    remaining, willFail: false, tight,
    message: tight
      ? `₹${remaining.toLocaleString("en-IN")} of headroom left under the autopay limit. One more seat increase is likely to break it.`
      : `₹${remaining.toLocaleString("en-IN")} of headroom under the autopay limit.`,
  };
}

/**
 * Which gateway events may move a mandate into which state.
 *
 * Written as data so the webhook cannot invent a transition, and so a state this app
 * believes in always corresponds to something Razorpay actually said.
 */
export const GATEWAY_TRANSITIONS: Record<string, StoredMandateStatus> = {
  "subscription.authenticated": "active",
  "subscription.activated":     "active",
  "subscription.charged":       "active",
  "subscription.pending":       "paused",
  "subscription.halted":        "paused",
  "subscription.cancelled":     "cancelled",
  "subscription.completed":     "expired",
  "subscription.expired":       "expired",
};

/**
 * Apply a gateway event.
 *
 * Returns null when the event does not map to a state, or when the mandate is
 * already in a terminal state — a cancelled mandate must not be resurrected by a
 * late `subscription.charged` arriving out of order, which webhooks do.
 */
export function applyGatewayEvent(current: MandateStatus, event: string): StoredMandateStatus | null {
  const next = GATEWAY_TRANSITIONS[event];
  if (!next) return null;
  if (current === "cancelled" || current === "expired") return null;
  if (next === current) return null;
  return next;
}

/** Badge for the portal and for the rep's subscription row. */
export function mandateBadge(status: MandateStatus, testMode: boolean): {
  label: string; kind: "success" | "warning" | "muted" | "danger";
} {
  /* Test mode is on the badge, not only in a tooltip. A reseller looking at
     "Autopay active" has to be able to tell at a glance whether real money will
     move. */
  const suffix = testMode ? " (test)" : "";
  switch (status) {
    case "active":                return { label: `Autopay on${suffix}`, kind: "success" };
    case "pending_authorisation": return { label: "Waiting for approval", kind: "warning" };
    case "paused":                return { label: "Autopay stopped", kind: "danger" };
    case "cancelled":             return { label: "Autopay cancelled", kind: "muted" };
    case "expired":               return { label: "Autopay expired", kind: "muted" };
    default:                      return { label: "No autopay", kind: "muted" };
  }
}
