/**
 * ResellerClub — response classification.
 *
 * ─── WHY THIS IS ITS OWN FILE, AND WHY IT IS PURE ────────────────────────────
 * Registering or renewing a domain spends real money at the registrar and
 * cannot be undone. The single most expensive mistake available in that flow is
 * not a failed call — it is a call that SUCCEEDED UPSTREAM and was read as a
 * failure, because the obvious response to a failure is to try again, and the
 * second try either registers the name twice or renews it for a second year
 * nobody asked for.
 *
 * ResellerClub does not make this easy. It reports "the order is queued behind
 * your account balance", "the order is locked for processing", and "you already
 * have a pending order for this name" as **errors**, in prose, with no code to
 * key on. All three mean *stop and come back later*, not *failed, retry now*.
 *
 * So this module exists to turn RC's prose into three decisions:
 *   · did it happen            → act on it
 *   · might it still happen    → wait, never retry
 *   · did it definitely not    → safe to retry or to tell a human
 *
 * It is pure — no fetch, no logging, no env — so every branch is unit-testable
 * without credentials, without the network, and without a database. That is not
 * a stylistic preference: the vocabulary below is the only part of the domain
 * integration whose correctness can be proved on a laptop, and it is also the
 * part where being wrong costs money.
 *
 * ─── PROVENANCE ──────────────────────────────────────────────────────────────
 * The fragment lists are ported verbatim from the engine that has been running
 * this against live ResellerClub traffic since June 2026
 * (domain-management-system: lib/integrations/resellerclub/classify.ts). They
 * are observed wordings, not guesses, and each one was added because a real
 * order was misread. Do not "tidy" them — a fragment that looks redundant is
 * usually a wording RC used exactly once, expensively.
 */

/* ── The vocabulary ─────────────────────────────────────────────────────────── */

/**
 * RC defers an order for credit reasons. The name is NOT registered yet, but it
 * may be the moment the reseller account is topped up, so retrying is how you
 * end up with two orders for one name.
 */
export const BALANCE_PENDING_FRAGMENTS = [
  "insufficient balance",
  "low funds",
  "insufficient funds",
  "account balance",
  "credit limit",
  /* RC sometimes wraps a balance problem in a generic support-contact message
     without naming the cause. Treated as pending so a sweep can drain it. */
  "please contact support",
] as const;

/** The order is queued at the registry — lock contention, racing orders. */
export const PROCESSING_LOCK_FRAGMENTS = [
  "order locked for processing",
  "locked for processing",
  "processing",
] as const;

/** The same name is already in flight on our own reseller account. */
export const ALREADY_IN_PROGRESS_FRAGMENTS = [
  "already exists in our database",
  "pending order",
  "pending order for",
] as const;

/** A read op asked about a name that is not on our account. */
export const READ_NOT_FOUND_FRAGMENTS = [
  "404",
  "not found",
  "no orders found",
  "no order found",
  "no matching",
  "no entity found",
  "no domain",
  "does not exist",
  /* RC's ACTUAL wording, seen 11 Sep 2026 with live credentials:
     "Website doesn't exist for anutech.in". The contraction is not covered by
     "does not exist", so a domain that simply is not on this reseller account
     was classified as a hard_failure — i.e. "ResellerClub is broken" instead of
     "not ours". asset-sweep treats those two very differently. */
  "doesn't exist",
  "could not find",
] as const;

/**
 * The registry refused a transfer. Distinct from a hard failure because every
 * one of these is user-actionable — get the right EPP code, unlock at the
 * losing registrar, or wait out the 60-day post-registration lock — and
 * "transfer failed" tells the customer none of that (§24).
 */
export const TRANSFER_REJECTED_FRAGMENTS = [
  "auth code",
  "auth-code",
  "authcode",
  "invalid epp",
  "transfer is prohibited",
  "clienttransferprohibited",
  "serverttransferprohibited",
  "60 day",
  "60-day",
  "60days",
  "60 days",
  "not allowed for transfer",
] as const;

export function matchesAny(haystack: string | undefined | null, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/* ── What a call gives us ───────────────────────────────────────────────────── */

/**
 * The raw shape every RC write returns once the transport layer is done with
 * it. `status` is ours, not RC's: the transport collapses HTTP failures and
 * RC's own `{status:"error"}` bodies into the same three words.
 */
export interface RcRawResponse {
  status: "success" | "pending" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

/* ── Outcomes ───────────────────────────────────────────────────────────────── */

export type RegisterOutcome =
  /** Done, and we have the registrar's order id — the idempotency key. */
  | { kind: "registered"; orderId: string }
  /**
   * Done, but RC did not give us an order id. This is a real state and it is
   * NOT a success we can file: without the order id we cannot renew, transfer
   * or even prove ownership later, so the caller must go and look the order up
   * by name rather than write a row with a hole in it.
   */
  | { kind: "registered_no_order_id" }
  /** May still complete upstream. Never retry — wait and re-check by name. */
  | { kind: "balance_pending" }
  /** We already have an order in flight for this name. Also never retry. */
  | { kind: "already_in_progress" }
  /** It definitely did not happen. Safe to surface, safe to retry. */
  | { kind: "hard_failure"; reason: string };

export type RenewOutcome =
  | { kind: "renewed"; orderId?: string; price?: number }
  | { kind: "balance_pending" }
  | { kind: "hard_failure"; reason: string };

export type TransferOutcome =
  | { kind: "transfer_initiated"; entityId?: string }
  | { kind: "balance_pending" }
  | { kind: "transfer_rejected"; reason: string }
  | { kind: "hard_failure"; reason: string };

export type LookupOutcome<T> =
  | { kind: "found"; value: T }
  | { kind: "not_found"; reason: string }
  | { kind: "hard_failure"; reason: string };

/* ── Classifiers ────────────────────────────────────────────────────────────── */

/**
 * Order matters here and is not arbitrary.
 *
 * `already_in_progress` is checked LAST of the three deferral cases because its
 * fragments are the loosest — "pending order" would swallow a balance message
 * that happens to mention a pending order, and the two are drained differently:
 * a balance-pending order completes on its own once the account is funded, while
 * an already-in-progress order means somebody must go and look at what is
 * already there. Both refuse a retry, so a mix-up is not dangerous — just
 * unhelpful to whoever reads the queue.
 */
export function classifyRegister(res: RcRawResponse): RegisterOutcome {
  if (res.status === "success") {
    const orderId = res.data?.orderid != null ? String(res.data.orderid) : "";
    return orderId ? { kind: "registered", orderId } : { kind: "registered_no_order_id" };
  }

  if (res.status === "pending") return { kind: "balance_pending" };

  if (matchesAny(res.message, BALANCE_PENDING_FRAGMENTS)) return { kind: "balance_pending" };
  if (matchesAny(res.message, PROCESSING_LOCK_FRAGMENTS)) return { kind: "balance_pending" };
  if (matchesAny(res.message, ALREADY_IN_PROGRESS_FRAGMENTS)) return { kind: "already_in_progress" };

  return {
    kind: "hard_failure",
    reason: res.message || `ResellerClub returned status=${res.status} with no message`,
  };
}

/**
 * Renew shares register's balance vocabulary — RC words a short account the
 * same way for both — but has no `already_in_progress`: renewing twice is a
 * money event RC itself refuses, and its refusal reads as a hard failure, which
 * is the correct thing for a human to see.
 */
export function classifyRenew(res: RcRawResponse): RenewOutcome {
  if (res.status === "success") {
    const orderId = res.data?.orderid != null ? String(res.data.orderid) : undefined;
    const raw = res.data?.price;
    const price = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
    return { kind: "renewed", orderId, price: Number.isFinite(price) ? price : undefined };
  }

  if (res.status === "pending") return { kind: "balance_pending" };
  if (matchesAny(res.message, BALANCE_PENDING_FRAGMENTS)) return { kind: "balance_pending" };
  if (matchesAny(res.message, PROCESSING_LOCK_FRAGMENTS)) return { kind: "balance_pending" };

  return {
    kind: "hard_failure",
    reason: res.message || `ResellerClub returned status=${res.status} with no message`,
  };
}

/**
 * Balance is checked BEFORE rejection here, deliberately. A transfer that is
 * merely unfunded must not be reported to the customer as "your EPP code is
 * wrong" — they would go and get a new code, which cannot help, and we would
 * have blamed them for our own account balance.
 */
export function classifyTransfer(res: RcRawResponse): TransferOutcome {
  if (res.status === "success") {
    const entityId = res.data?.entityid != null ? String(res.data.entityid) : undefined;
    return { kind: "transfer_initiated", entityId };
  }

  if (res.status === "pending") return { kind: "balance_pending" };
  if (matchesAny(res.message, BALANCE_PENDING_FRAGMENTS)) return { kind: "balance_pending" };
  if (matchesAny(res.message, PROCESSING_LOCK_FRAGMENTS)) return { kind: "balance_pending" };

  if (matchesAny(res.message, TRANSFER_REJECTED_FRAGMENTS)) {
    return { kind: "transfer_rejected", reason: res.message || "the registry rejected the transfer" };
  }

  return {
    kind: "hard_failure",
    reason: res.message || `ResellerClub returned status=${res.status} with no message`,
  };
}

/**
 * Reads. `not_found` is separated from `hard_failure` because they mean
 * opposite things to a sweep: not-found is an answer (the name is not ours,
 * stop asking), a hard failure is the absence of one (RC is down, ask again).
 * Collapsing them is how a sweep marks every domain as lost during an outage.
 */
export function classifyLookup<T>(res: RcRawResponse, extract: (data: Record<string, unknown>) => T | null): LookupOutcome<T> {
  if (res.status === "success" && res.data) {
    const value = extract(res.data);
    if (value === null || value === undefined || value === "") {
      return { kind: "not_found", reason: "ResellerClub answered but the field we needed was empty" };
    }
    return { kind: "found", value };
  }

  if (matchesAny(res.message, READ_NOT_FOUND_FRAGMENTS)) {
    return { kind: "not_found", reason: res.message || "ResellerClub reports no such record" };
  }

  return {
    kind: "hard_failure",
    reason: res.message || `ResellerClub returned status=${res.status} with no message`,
  };
}

/**
 * True when an outcome means "the upstream state is unknown or still moving".
 *
 * The single most important predicate in this file. A caller that retries on
 * one of these buys the same domain twice. Written as a function rather than
 * left to each call site's `if`, because there will be more call sites than
 * there are today and one of them will forget a case.
 */
export function mustNotRetry(
  outcome: RegisterOutcome | RenewOutcome | TransferOutcome,
): boolean {
  return outcome.kind === "balance_pending"
    || outcome.kind === "already_in_progress"
    || outcome.kind === "registered_no_order_id";
}
