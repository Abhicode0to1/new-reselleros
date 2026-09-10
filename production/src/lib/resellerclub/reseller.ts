/**
 * ResellerClub — our OWN account, and how much is in it.
 *
 * Ported from the DMS engine's `getResellerDetails` (lib/resellerclub/search.ts)
 * on 10 Sep 2026.
 *
 * ─── WHY THIS IS WORTH HAVING ────────────────────────────────────────────────
 * Every domain registration is paid for out of the ResellerClub wallet at the
 * moment it is placed. When that wallet is empty the registration fails — after
 * the customer's money has already been taken by us. That is the worst failure
 * in the whole domain path: a paid order with nothing delivered, discovered by
 * the customer rather than by us, and needing a refund and an apology.
 *
 * So the balance is worth being able to see BEFORE a sale, and worth a check on
 * a schedule. DMS used it in exactly those three places — an admin balance
 * view, a system-health probe, and the daily scheduler — and that judgement is
 * kept.
 *
 * ─── WHAT IS NOT KEPT: THE LOGGING ──────────────────────────────────────────
 * DMS logged the whole response at info level in three separate statements,
 * including `JSON.stringify(response.data, null, 2)` — so the company's wallet
 * balance, receipts total and locked funds were written into the log
 * aggregator on every call, including from a cron. Nothing here logs an amount.
 * A failure logs that it failed.
 *
 * ─── THE BALANCES ARE STRINGS, AND THEY ARE MONEY ───────────────────────────
 * RC sends them as strings ("14523.65"), which is a decimal — unlike this app's
 * own money columns, which are integer rupees (see AGENTS.md). These are not
 * ours and are not persisted, so they are parsed to numbers for display and
 * comparison only. `null` where RC did not say, never 0: a wallet that failed
 * to report is not an empty one, and "₹0 available" would stop every sale.
 */
import "server-only";
import { rcCall } from "./call";

export interface RcResellerAccount {
  resellerId: string | null;
  name: string | null;
  /**
   * Spendable right now. This is the number that decides whether the next
   * registration will go through. Null = RC did not report it.
   */
  availableBalance: number | null;
  /** Credit RC extends that has not been used yet. */
  unutilisedSellingBalance: number | null;
  /** Held against orders in flight — real money, but not spendable. */
  lockedBalance: number | null;
  billingMode: string | null;
  status: string | null;
  /** Everything RC sent, for fields nothing has needed to name yet. */
  raw: Record<string, string>;
}

export type RcResellerOutcome =
  | { kind: "read"; account: RcResellerAccount }
  /** Our own precondition; nothing was sent. */
  | { kind: "refused"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * RC's money strings. Anything unparseable stays NULL rather than becoming 0 —
 * see the header: a false zero here reads as "the wallet is empty" and would
 * stop sales the account can perfectly well fund.
 */
export function parseRcAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  /* RC has been seen to send thousands separators. */
  const cleaned = v.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown): string | null => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/**
 * Read RC's reseller payload.
 *
 * DMS had to guess at the envelope — "Some APIs return { status, data }, others
 * return the data directly" — and unwrapped a nested `data` when it found one.
 * That guess is kept because it is cheap and the alternative is reading every
 * field as absent on whichever shape we did not expect.
 */
export function parseResellerDetails(body: Record<string, unknown>): RcResellerAccount {
  const inner =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;

  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(inner)) {
    if (typeof v === "string" || typeof v === "number") raw[k] = String(v);
  }

  return {
    resellerId: str(inner.resellerid) ?? str(inner.resellerId),
    name: str(inner.name),
    availableBalance: parseRcAmount(inner.availablebalance),
    unutilisedSellingBalance: parseRcAmount(inner.unutilisedsellingbalance),
    lockedBalance: parseRcAmount(inner.lockedbalance),
    billingMode: str(inner.billingmode),
    status: str(inner.resellerstatus),
    raw,
  };
}

/**
 * Whether the wallet can fund an order of `amount`.
 *
 * Returns null when the balance is unknown — the caller must NOT read that as
 * "no". Blocking a sale because a balance check failed is its own outage, and
 * the honest handling is to let the order through and let RC refuse it if it
 * really cannot be paid for. A refusal from RC happens before the registry is
 * touched; a blocked checkout happens in front of the customer.
 */
export function canFund(account: RcResellerAccount, amount: number): boolean | null {
  if (account.availableBalance === null) return null;
  return account.availableBalance >= amount;
}

/** Our ResellerClub account, including the spendable balance. */
export async function rcResellerAccount(): Promise<RcResellerOutcome> {
  const res = await rcCall("/api/resellers/details.json", {}, "GET");

  if (res.status === "error") {
    /* rcCall already logged the failure without the URL (it carries the api-key).
       Nothing is added here, and no amount is ever logged. */
    return { kind: "hard_failure", reason: res.message ?? "ResellerClub did not return account details." };
  }
  if (res.status === "pending") {
    /* Not a shape this endpoint produces, but rcCall's contract allows it and
       silently treating it as success would be a guess. */
    return { kind: "hard_failure", reason: "ResellerClub gave an unexpected response for account details." };
  }
  if (!res.data) {
    return { kind: "hard_failure", reason: "ResellerClub returned no account details." };
  }

  return { kind: "read", account: parseResellerDetails(res.data as Record<string, unknown>) };
}
