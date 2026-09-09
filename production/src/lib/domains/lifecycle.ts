/**
 * Where a domain or hosting account IS in its life, and when to look again.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `domains.expires_at` was written exactly once — by `provision-domain`, at the
 * moment of registration — and never again. So the portal's countdown ("12d
 * left") was true on the day of purchase and drifted from that morning on: a
 * domain renewed at the registrar still showed the old date, and an expired one
 * still showed "Active". The asset tables were a system of record with nothing
 * keeping the record current.
 *
 * This file is the arithmetic; `api/cron/asset-sweep` is the wiring that fetches
 * and writes. It is split that way because the arithmetic is the part worth
 * testing and a cron route is the part that cannot be.
 *
 * ─── THE ONE RULE THAT SHAPES EVERYTHING HERE ────────────────────────────────
 * A FAILED READ IS NOT A LIFECYCLE EVENT. Every function returns `null` for
 * "leave it alone" rather than guessing, because the alternative is a customer
 * opening the portal to find a domain they still own marked as lost. That is the
 * same defect family this repo has now fixed three times in ported code: an
 * error read as an absence.
 */

import type { DomainAssetStatus, HostingAccountStatus } from "@/lib/supabase/database.types";

/** Whole days from `now` to `at`. Negative when `at` is in the past. */
export function daysUntil(at: string | Date, now: Date = new Date()): number {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Math.floor((t - now.getTime()) / 86_400_000);
}

/* ── Domains ────────────────────────────────────────────────────────────────── */

/**
 * The ICANN post-expiry ladder, in days after `expires_at`.
 *
 * These are not arbitrary and they are not ours: after expiry a gTLD normally
 * sits in an auto-renew grace period, then a redemption period during which the
 * name can still be recovered for a fee, and only then is it released. The two
 * states are kept apart because collapsing them into "expired" loses the only
 * thing the customer needs to know — whether the name can still be saved, and at
 * what cost. Registries vary (and .in differs from .com), so these are the
 * common case, used ONLY when the registrar has not told us a status itself.
 */
export const GRACE_DAYS = 30;
export const REDEMPTION_DAYS = 60;

/** Inside this window before expiry, a domain is worth shouting about. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * ResellerClub's own lifecycle words, lowercased, mapped to ours.
 *
 * RC's word WINS over our date arithmetic wherever it maps, because RC is the
 * one talking to the registry — if it says a domain is suspended, no amount of
 * "expires in 200 days" makes that untrue. Anything RC says that is not on this
 * list is deliberately unmapped: an unknown word falls through to the dates
 * rather than being forced into the nearest-looking state.
 */
const RC_STATUS_MAP: Record<string, DomainAssetStatus> = {
  active: "active",
  suspended: "suspended",
  pendingdelete: "redemption",
  "pending delete": "redemption",
  pendingdeleterestorable: "redemption",
  deleted: "cancelled",
  transferred: "transferred_out",
  transferredaway: "transferred_out",
  inactive: "pending",
  pendingverification: "pending",
};

export interface DomainLifecycleInput {
  /** What the row says today. */
  current: DomainAssetStatus;
  /** RC's `orderstatus` / `currentstatus`, if the read succeeded. */
  registrarStatus?: string | null;
  /** RC's expiry, if the read succeeded. */
  expiresAt?: string | Date | null;
  now?: Date;
}

/**
 * The status a domain should carry, or `null` to leave it as it is.
 *
 * `null` is returned far more often than a caller might expect, and every case
 * is deliberate:
 *   · nothing was learned upstream (no status, no expiry) — see the header rule;
 *   · the row is in a state the sweep has no business overriding. `failed` and
 *     `cancelled` are OUR words about OUR attempt, and `transferred_out` is
 *     terminal; a date cannot undo any of them.
 */
export function deriveDomainStatus(input: DomainLifecycleInput): DomainAssetStatus | null {
  const { current, registrarStatus, expiresAt, now = new Date() } = input;

  /* Terminal or self-inflicted states the arithmetic must not touch. */
  if (current === "failed" || current === "cancelled" || current === "transferred_out") return null;

  const word = (registrarStatus ?? "").trim().toLowerCase().replace(/[_-]/g, "");
  const mapped = word ? RC_STATUS_MAP[word] ?? RC_STATUS_MAP[registrarStatus!.trim().toLowerCase()] : undefined;

  /* RC's own word, when it maps. "active" is the exception: RC calls a domain
     active right up to the expiry date, so it does not get to overrule the
     countdown — otherwise nothing would ever reach `expiring_soon`. */
  if (mapped && mapped !== "active") return mapped === current ? null : mapped;

  if (expiresAt === null || expiresAt === undefined || expiresAt === "") {
    /* No expiry learned. If RC said "active" and we have nothing else, at least
       promote a `pending` row that clearly did land upstream. */
    if (mapped === "active" && current === "pending") return "active";
    return null;
  }

  const days = daysUntil(expiresAt, now);
  let next: DomainAssetStatus;
  if (days > EXPIRING_SOON_DAYS) next = "active";
  else if (days >= 0) next = "expiring_soon";
  else if (days >= -GRACE_DAYS) next = "grace";
  else if (days >= -REDEMPTION_DAYS) next = "redemption";
  else {
    /* Past redemption the name is normally released — but "released" is a claim
       about the registry we have not verified, and telling a customer their
       domain is gone when it is not is far worse than leaving it in redemption
       for a human to look at. */
    next = "redemption";
  }

  return next === current ? null : next;
}

/**
 * When to look at this row again.
 *
 * Tighter as expiry approaches, because that is when a day of staleness costs
 * something: inside the last week the portal is being read by somebody deciding
 * whether to renew. Far from expiry a weekly check is plenty, and hammering RC
 * daily for 300-day-out domains only spends rate limit.
 */
export function nextDomainCheckAt(input: {
  status: DomainAssetStatus;
  expiresAt?: string | Date | null;
  now?: Date;
}): string {
  const { status, expiresAt, now = new Date() } = input;
  const plus = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();

  /* Nothing upstream will change on its own for these. */
  if (status === "cancelled" || status === "transferred_out" || status === "failed") return plus(30);
  /* A registration still landing is the one case worth checking hourly. */
  if (status === "pending") return new Date(now.getTime() + 60 * 60_000).toISOString();

  if (expiresAt === null || expiresAt === undefined || expiresAt === "") return plus(1);

  const days = daysUntil(expiresAt, now);
  if (days < 0) return plus(1);        // in grace or redemption — the deadline is live
  if (days <= 7) return plus(1);
  if (days <= EXPIRING_SOON_DAYS) return plus(2);
  if (days <= 90) return plus(7);
  return plus(14);
}

/* ── Hosting ────────────────────────────────────────────────────────────────── */

/**
 * The status a hosting account should carry, or `null` to leave it.
 *
 * Date arithmetic only, and that is a limitation worth naming rather than
 * hiding: there is no DirectAdmin read in this app that reports an account's
 * expiry, so unlike a domain there is no upstream truth to reconcile against.
 * What this can do is stop an ended trial from displaying as a live account,
 * which is the case that actually misleads somebody.
 *
 * A trial counts down to `trial_ends_at` and a paid account to `expires_at`;
 * reading the wrong one tells a trial customer they have a year.
 */
export function deriveHostingStatus(input: {
  current: HostingAccountStatus;
  isTrial: boolean;
  trialEndsAt?: string | Date | null;
  expiresAt?: string | Date | null;
  now?: Date;
}): HostingAccountStatus | null {
  const { current, isTrial, trialEndsAt, expiresAt, now = new Date() } = input;

  /* Ours to say, not a date's. `suspended` is excluded too: it is usually a
     deliberate act (non-payment, abuse), and an expiry date must not quietly
     lift it. */
  if (current === "terminated" || current === "failed" || current === "pending" || current === "suspended") {
    return null;
  }

  const deadline = isTrial ? trialEndsAt : expiresAt;
  if (deadline === null || deadline === undefined || deadline === "") return null;

  const days = daysUntil(deadline, now);
  if (days < 0 && current !== "expired") return "expired";
  return null;
}

/* ── The disagreement the schema was designed to surface ────────────────────── */

/**
 * How far the registrar's expiry and the billing renewal date have drifted.
 *
 * The migration keeps `domains.expires_at` (the registrar's truth) and
 * `subscriptions.renewal_date` (what we bill) deliberately separate, and says
 * their disagreement "is the real signal". This is that comparison, in days.
 *
 * It reports and never repairs. Either side could be the wrong one — a domain
 * renewed for two years upstream while billing still expects twelve months is a
 * pricing conversation, not a field to overwrite — so the sweep surfaces the
 * number and a person decides. Returns null when there is nothing to compare.
 */
export function expiryDisagreementDays(
  expiresAt: string | Date | null | undefined,
  renewalDate: string | Date | null | undefined,
): number | null {
  if (!expiresAt || !renewalDate) return null;
  const a = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  const b = renewalDate instanceof Date ? renewalDate.getTime() : new Date(renewalDate).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** Worth a human's attention. A few days of drift is billing-cycle noise. */
export const DISAGREEMENT_TOLERANCE_DAYS = 7;

export function disagreementIsWorthFlagging(days: number | null): boolean {
  return days !== null && Math.abs(days) > DISAGREEMENT_TOLERANCE_DAYS;
}
