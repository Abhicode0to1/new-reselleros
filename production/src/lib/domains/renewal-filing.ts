/**
 * Should we file this renewal at the registrar? The decision that spends money.
 *
 * ─── WHY IT IS A FUNCTION WITH TESTS ────────────────────────────────────────
 * Filing a renewal draws real money from the reseller's ResellerClub wallet and
 * cannot be undone. Two ways to get it wrong, both expensive and both quiet:
 *
 *   · FILE WITHOUT THE MONEY. A renewal filed against a quote nobody paid is the
 *     reseller buying a year for a customer who did not ask, and nothing errors.
 *   · FILE TWICE. ResellerClub's renew API takes `exp-date` and uses it to spot a
 *     repeat, but only if we send the CURRENT expiry. If a renewal already landed
 *     and we did not record it — a crash after the call, an operator renewing by
 *     hand at the registrar — then re-filing buys a second year at full price.
 *
 * The second is what `from_expires_at` exists for. RC's live expiry is read
 * immediately before filing and compared: if it has already moved past the term
 * we quoted against, the renewal HAS happened and this refuses rather than
 * filing again.
 *
 * ─── AND ONE WAY TO BE WRONG IN THE OTHER DIRECTION ─────────────────────────
 * If RC's expiry is EARLIER than the date we quoted against, our record was ahead
 * of the registrar's and nobody knows why. That is not a renewal to file on a
 * guess — the amount and the term are both in doubt — so it goes to a person.
 */

/** Payment state of the linked quote, as `quotes.payment_status` holds it. */
export type QuotePaymentState = "awaiting" | "partial" | "received" | "invoiced" | "none" | null;

export type RenewalFilingDecision =
  /** Send it. `expiryEpochSeconds` is what goes in RC's `exp-date`. */
  | { action: "file"; years: number; expiryEpochSeconds: number }
  /**
   * The registrar has already extended past the term we quoted. Record it as
   * renewed — do NOT file — and take the new date from the registrar.
   */
  | { action: "already_renewed"; reason: string }
  /** Nothing to do yet, and that is normal. */
  | { action: "wait"; reason: string }
  /** Something a person has to look at before money moves. */
  | { action: "refuse"; reason: string; nextStep: string };

/**
 * `YYYY-MM-DD` → Unix seconds at IST midnight.
 *
 * IST because every other date in this app is an IST calendar date, and a UTC
 * midnight would put the boundary at 05:30 local — so a renewal quoted on the
 * expiry date itself could compare as a day out.
 */
export function istDateToEpochSeconds(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  const [, y, mo, d] = m;
  return Math.trunc(Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0) / 1000) - 5.5 * 3600;
}

export function decideRenewalFiling(args: {
  /** `domain_renewals.status`. */
  renewalStatus: "quoted" | "renewed" | "failed" | "cancelled";
  /** `quotes.payment_status` for the linked quote. */
  quotePayment: QuotePaymentState;
  years: number;
  /** `domain_renewals.from_expires_at`, `YYYY-MM-DD`. */
  fromExpiresAt: string;
  /** What ResellerClub says the expiry is RIGHT NOW, Unix seconds. */
  liveExpiryEpochSeconds: number | null;
  /** RC's order id for this domain, read live. */
  liveOrderId: string | null;
}): RenewalFilingDecision {
  if (args.renewalStatus !== "quoted") {
    return { action: "wait", reason: `this renewal is already ${args.renewalStatus}` };
  }

  /* ─── THE MONEY GATE ───────────────────────────────────────────────────────
     Fully paid, nothing less. A partial payment on a renewal is not a renewal
     the customer has bought — filing on it would have the reseller covering the
     balance out of their own wallet. */
  if (args.quotePayment !== "received" && args.quotePayment !== "invoiced") {
    return {
      action: "wait",
      reason: `the quote is ${args.quotePayment ?? "unpaid"} — a renewal is filed only once it is paid in full`,
    };
  }

  if (!args.liveOrderId) {
    return {
      action: "refuse",
      reason: "ResellerClub has no order id for this domain, so there is nothing to renew there.",
      nextStep:
        "This name was not registered through ResellerClub on this account. Renew it wherever it actually lives, then set the expiry on the domain by hand.",
    };
  }

  if (args.liveExpiryEpochSeconds === null || !Number.isFinite(args.liveExpiryEpochSeconds)) {
    return {
      action: "refuse",
      reason: "ResellerClub did not tell us the current expiry, and a renewal cannot be filed without it.",
      nextStep:
        "Retry once ResellerClub is answering. Filing without the current expiry is how a domain gets renewed twice — see rcRenewDomain.",
    };
  }

  const quoted = istDateToEpochSeconds(args.fromExpiresAt);
  if (quoted === null) {
    return {
      action: "refuse",
      reason: `"${args.fromExpiresAt}" is not a date this renewal can be measured from.`,
      nextStep: "Cancel this renewal and raise it again from the domain page.",
    };
  }

  /* One day of slack. Registrars report expiry at their own time of day and the
     quoted value is an IST midnight, so an exact-equality test would call a
     perfectly normal same-day pair a mismatch. A real renewal moves the date by
     a year, which is three orders of magnitude past this. */
  const DAY = 86_400;

  if (args.liveExpiryEpochSeconds > quoted + DAY) {
    return {
      action: "already_renewed",
      reason:
        "ResellerClub's expiry is already past the term this was quoted against, so the renewal has been filed — by an earlier attempt, or by hand at the registrar.",
    };
  }

  if (args.liveExpiryEpochSeconds < quoted - DAY) {
    /* Our record was AHEAD of the registrar's. Nobody knows why, and both the
       term and the amount are now in doubt. */
    return {
      action: "refuse",
      reason:
        "ResellerClub says this domain expires EARLIER than the date we quoted the renewal against.",
      nextStep:
        "Our record was ahead of the registrar's. Check the domain at ResellerClub and correct the expiry here before filing anything — the term the customer paid for may not be the term they would get.",
    };
  }

  return {
    action: "file",
    years: args.years,
    /* RC's own value, not ours. Its whole purpose is to match what the registrar
       holds so the registrar can reject a duplicate. */
    expiryEpochSeconds: Math.trunc(args.liveExpiryEpochSeconds),
  };
}
