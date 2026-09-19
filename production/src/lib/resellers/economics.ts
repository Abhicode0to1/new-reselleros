/**
 * Sub-reseller economics: what they may do, what they add, what they have left.
 *
 * Ported from the DMS engine's `Reseller` model on 10 Sep 2026. DMS carried the
 * fields and called them "DORMANT until later phases"; the arithmetic never
 * existed anywhere. It does now, and it is tested, because every function here
 * decides a rupee figure or whether somebody may trade.
 *
 * ─── A RESELLER IS A TENANT ──────────────────────────────────────────────────
 * `tenants.tier = 'reseller'` with a `parent_tenant_id`. See the migration
 * (20260910120000) for why this is not its own table.
 *
 * ─── THE BALANCE IS NEVER STORED ─────────────────────────────────────────────
 * It is the sum of an append-only ledger. DMS kept a mutable `walletBalance`
 * number, which is the oldest bug in accounting software: the running total and
 * the movements that produced it drift apart, and then nobody can say which is
 * wrong. `walletBalance()` below is the only way to get a balance.
 */

/** Whether a reseller may trade. NOT the same as `tier`. */
export type ResellerStatus = "pending" | "approved" | "suspended";

export const RESELLER_STATUSES: readonly ResellerStatus[] = ["pending", "approved", "suspended"];

export function isResellerStatus(v: string | null | undefined): v is ResellerStatus {
  return RESELLER_STATUSES.includes((v ?? "") as ResellerStatus);
}

/* ── Trading permission ──────────────────────────────────────────────────────── */

export type TradeVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * May this reseller place an order right now?
 *
 * Only `approved` may. Both refusals say what has to happen next, because the
 * person reading this is a reseller who has just been stopped and "not allowed"
 * tells them nothing about who to ask (§24).
 *
 * `tier` is checked too: a `distributor` is not gated by this at all, and a
 * tenant with no reseller relationship should not be silently treated as one.
 */
export function canTrade(input: {
  tier: string;
  resellerStatus: string;
}): TradeVerdict {
  if (input.tier !== "reseller") {
    /* Not a sub-reseller — a distributor trades on its own account and this gate
       does not apply to it. Allowed rather than refused, because refusing here
       would break the ordinary single-tenant case. */
    return { allowed: true };
  }
  switch (input.resellerStatus) {
    case "approved":
      return { allowed: true };
    case "pending":
      return {
        allowed: false,
        reason: "This reseller account has not been approved yet. The distributor who signed you up has to approve it before orders can be placed.",
      };
    case "suspended":
      return {
        allowed: false,
        reason: "This reseller account is suspended, so orders cannot be placed. Contact your distributor to have it reinstated.",
      };
    default:
      /* An unrecognised status must not read as approved. A typo in a status
         column becoming "yes, trade freely" is the wrong direction to fail. */
      return {
        allowed: false,
        reason: `This reseller account is in an unrecognised state (${input.resellerStatus || "unset"}), so orders are held. Somebody needs to look at it.`,
      };
  }
}

/* ── Markup: REMOVED, and this is the note explaining why ──────────────────
 *
 * `applyMarkup`, `resellerMargin`, `markupLabel` and `tenants.markup_bps` lived
 * here for a day (10 Sep 2026) and were removed the same day, before anything
 * used them — see migration 20260910150000. Wiring them up would have corrupted
 * customer totals rather than filling a gap.
 *
 * A RESELLER'S MARGIN ALREADY EXISTS, PER ITEM. `items` is tenant-scoped and
 * carries `wholesale` (what it costs this tenant), `msrp` (what this tenant
 * sells it for) and `margin_pct`, GENERATED from the two. A real row on this
 * database: Google Workspace Enterprise, wholesale ₹2,050, msrp ₹2,400, margin
 * 14%. Quotes and invoices price from `msrp`, which is already retail — so 2.5%
 * on top would have charged ₹2,460 while the intended ₹350 was already inside
 * the ₹2,400.
 *
 * DMS needed a percentage because it had ONE shared catalogue and a reseller
 * there could not set their own price. This app gave every tenant its own
 * catalogue, which makes the percentage redundant. The column was ported
 * faithfully without first asking whether the problem still existed; that
 * question is the missing step, and this note is here so the next person to
 * reach for a markup finds the answer instead of the column.
 */


/* ── The wallet ──────────────────────────────────────────────────────────────── */

export type WalletReason = "topup" | "spend" | "refund" | "adjustment" | "reversal";

export interface WalletEntry {
  /** ₹ whole rupees, SIGNED. Positive in, negative out. Never 0. */
  amount: number;
  reason: WalletReason;
}

/**
 * The balance, which is the sum of the ledger and nothing else.
 *
 * There is no stored balance to compare this against on purpose — see the file
 * header. If a balance ever gets cached, this stays the definition and the cache
 * is reconciled against it.
 */
export function walletBalance(entries: ReadonlyArray<WalletEntry>): number {
  return entries.reduce((sum, e) => sum + (Number.isFinite(e.amount) ? e.amount : 0), 0);
}

export type SpendVerdict =
  | { allowed: true; remainingAfter: number }
  | { allowed: false; reason: string; shortBy: number };

/**
 * Can this wallet fund a spend of `amount`?
 *
 * REFUSES rather than allowing an overdraft. That is the opposite call to
 * `canFund` in `lib/resellerclub/reseller.ts`, and the difference is who bears
 * the risk: there, an unknown balance must not block OUR sale, because
 * ResellerClub will refuse the order itself before any registry is touched.
 * Here the balance is KNOWN and it is a prepaid arrangement — letting a
 * sub-reseller register domains they have not paid for makes us their creditor
 * without anyone agreeing to that.
 *
 * The refusal says the shortfall, because "insufficient balance" without a
 * number means the reseller has to guess how much to top up.
 */
export function canSpend(balance: number, amount: number): SpendVerdict {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { allowed: false, reason: "That is not an amount that can be charged to a wallet.", shortBy: 0 };
  }
  if (!Number.isFinite(balance)) {
    return { allowed: false, reason: "This wallet's balance could not be worked out, so nothing is being charged to it.", shortBy: 0 };
  }
  if (balance >= amount) {
    return { allowed: true, remainingAfter: balance - amount };
  }
  const shortBy = amount - balance;
  return {
    allowed: false,
    reason: `This costs ₹${amount} and the wallet holds ₹${balance} — ₹${shortBy} short. Top up before ordering.`,
    shortBy,
  };
}

/** Below this, the reseller is told to top up before it stops them mid-order. */
export const LOW_WALLET_FLOOR = 500;

/**
 * Worth warning about?
 *
 * Same shape as the ResellerClub wallet check in the health digest, and for the
 * same reason: an empty prepaid wallet stops orders, and finding that out at the
 * moment of sale is the expensive way to learn it.
 */
export function walletNeedsTopUp(balance: number, floor: number = LOW_WALLET_FLOOR): boolean {
  return Number.isFinite(balance) && balance < floor;
}

/* ── Slugs ───────────────────────────────────────────────────────────────────── */

/**
 * A URL-safe handle from a business name.
 *
 * Matches the `tenants_slug_shape` CHECK exactly — lowercase alphanumeric with
 * single hyphens, no leading or trailing hyphen, 3 to 63 characters. Returns null
 * when nothing usable survives, rather than inventing a slug: a tenant with no
 * slug is fine, and one with a meaningless slug owns a URL nobody can guess.
 */
export function slugify(businessName: string): string | null {
  const slug = (businessName ?? "")
    .toLowerCase()
    .normalize("NFKD")
    /* Drop combining marks so "Ácme" becomes "acme" rather than losing the A. */
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    /* The slice can leave a trailing hyphen behind. */
    .replace(/-+$/g, "");

  return slug.length >= 3 ? slug : null;
}

/**
 * The next free slug, given the ones already taken.
 *
 * Suffixes with -2, -3 … rather than a random string, because a reseller reads
 * their own slug and "acme-2" is explicable where "acme-f3a9" is not. Gives up
 * rather than looping forever; the caller must handle null.
 */
export function availableSlug(businessName: string, taken: ReadonlySet<string>, limit = 50): string | null {
  const base = slugify(businessName);
  if (!base) return null;
  if (!taken.has(base)) return base;
  for (let n = 2; n <= limit; n++) {
    /* Keep the suffix inside the 63-character cap. */
    const suffix = `-${n}`;
    const candidate = base.slice(0, 63 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}
