/**
 * Customer-raised hosting plan upgrades: what a rep may approve, and what it costs.
 *
 * This is the hosting twin of `lib/subscriptions/seat-request.ts` and it copies that
 * file's shape on purpose, because the two problems are the same problem: a customer
 * asks for more, the request sits in a queue, the world moves underneath it, and
 * somebody eventually presses Approve. Every hard lesson already learned there
 * applies here unchanged, so they are re-stated rather than re-discovered.
 *
 * ─── THE PRICE IS COMPUTED AT APPROVAL, NOT AT REQUEST ──────────────────────
 * An upgrade is priced pro-rata to the renewal date, so the amount falls every day
 * the request waits. Quoting at submission and billing at approval would show the
 * customer one figure and charge another. `previewUpgradeCharge` exists so both
 * sides can SEE the number for a given day; nothing stores it.
 *
 * ─── THE ACCOUNT MOVES UNDERNEATH PENDING REQUESTS ──────────────────────────
 * A customer asks for Starter → Plus. A week later a rep has already moved them to
 * Plus by hand. Approving now would be a second package change and a second charge
 * for something they already have. And the reverse is worse: if somebody moved them
 * DOWN to Starter in the meantime, "approve the Starter → Plus request" is no longer
 * the change the customer asked for. `assessPlanChange` refuses both rather than
 * guessing, which is why the plan at request time is stored on the request at all.
 *
 * ─── DOWNGRADES ARE NOT APPROVALS ───────────────────────────────────────────
 * This path only ever moves UP the ladder. A smaller package is a smaller disk
 * quota, and DirectAdmin applies a package immediately: moving an account onto a
 * quota below what it is currently using is how you break somebody's website and
 * their mail at the same time. It also needs a credit note, not a charge. So a
 * downgrade is routed to a human with the reason said out loud — never approved
 * into a code path that would half-work.
 *
 * ─── AN UNKNOWN CURRENT PLAN IS A REFUSAL, NOT A GUESS ──────────────────────
 * `hosting_accounts.plan_code` has held three shapes over this project's life
 * (`hosting-standard`, `standard`, and null on hand-provisioned rows), and
 * `da_package` holds DirectAdmin's own capitalisation. `planFromCode` tolerates all
 * of them, and returns null when it genuinely cannot tell. Null must never be
 * treated as "the smallest plan": that would offer an upgrade to a customer who may
 * already be on the largest, and charge them for it.
 */
import { prorate, rupeesToPaise, paiseToRupees } from "@/lib/subscriptions/proration";
import { LANDING_PLANS } from "@/site/lib/data/hosting-landing";

export type HostingPlanCode = "starter" | "standard" | "plus";

export interface HostingPlanSpec {
  code: HostingPlanCode;
  /** Display name, and also DirectAdmin's package name — they match today. */
  name: string;
  /**
   * The package name to send to DirectAdmin. Separate from `name` even though the
   * two are equal, because DA's names are case-sensitive and operator-editable:
   * when somebody renames a package on the server, this is the field that changes
   * and the customer-facing name that does not. See `normalizePackageName`.
   */
  daPackage: string;
  /** Position on the ladder. Higher is bigger. The only thing that defines "up". */
  rank: number;
  /** ₹/month when billed yearly. Fractional — see the money note below. */
  monthlyRate: number;
  storage: string;
  bandwidth: string;
  sites: string;
  /**
   * The limits in MB, for `hosting_accounts.disk_quota_mb` /
   * `bandwidth_quota_mb` after an upgrade lands.
   *
   * These are LIMITS, never usage. `asset-sweep` refuses to copy DirectAdmin's
   * consumed figure into these columns for exactly that reason — DA calls the
   * consumed number `quota` too, and copying it would quietly shrink a
   * customer's plan to whatever they happen to be using. Writing the new plan's
   * limits after a package change is the one time they legitimately move.
   */
  diskQuotaMb: number;
  bandwidthQuotaMb: number;
}

/**
 * The ladder, ordered smallest first.
 *
 * ─── ONE SOURCE OF PRICE ─────────────────────────────────────────────────────
 * `monthlyRate` comes from `LANDING_PLANS`, the same table the marketing page and
 * the catalogue sync read. A second copy here would be a second price, and the one
 * that drifted would be the one nobody was looking at.
 *
 * The rates are FRACTIONAL rupees (49.99 / 125 / 187.20). This app stores whole
 * rupees (CLAUDE.md §13 / AGENTS.md), so nothing here is stored — the fraction
 * survives only inside the paise arithmetic in `previewUpgradeCharge`, which is the
 * same trick `proration.ts` uses so a division rounds once instead of drifting.
 */
const GB = 1024;

const SPECS: Record<HostingPlanCode, Omit<HostingPlanSpec, "monthlyRate">> = {
  starter: {
    code: "starter", name: "Starter", daPackage: "Starter", rank: 1,
    storage: "10 GB", bandwidth: "20 GB", sites: "1",
    diskQuotaMb: 10 * GB, bandwidthQuotaMb: 20 * GB,
  },
  standard: {
    code: "standard", name: "Standard", daPackage: "Standard", rank: 2,
    storage: "25 GB", bandwidth: "30 GB", sites: "Multiple",
    diskQuotaMb: 25 * GB, bandwidthQuotaMb: 30 * GB,
  },
  plus: {
    code: "plus", name: "Plus", daPackage: "Plus", rank: 3,
    storage: "50 GB", bandwidth: "40 GB", sites: "Multiple",
    diskQuotaMb: 50 * GB, bandwidthQuotaMb: 40 * GB,
  },
};

export const HOSTING_PLAN_LADDER: readonly HostingPlanSpec[] = (["starter", "standard", "plus"] as const)
  .map((code) => {
    const priced = LANDING_PLANS.find((p) => p.planId === code);
    return { ...SPECS[code], monthlyRate: priced?.price ?? 0 };
  })
  .sort((a, b) => a.rank - b.rank);

/**
 * Resolve whatever is stored on the row to a plan on the ladder.
 *
 * Accepts `standard`, `hosting-standard`, `Standard`, `STANDARD`, and the display
 * name. Returns null for anything else — including null and empty string — because
 * "I do not know which plan this is" is a real answer here and the caller must
 * handle it rather than receive a default.
 */
export function planFromCode(raw: string | null | undefined): HostingPlanSpec | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/^hosting-/, "");
  if (!s) return null;
  return HOSTING_PLAN_LADDER.find((p) => p.code === s || p.name.toLowerCase() === s) ?? null;
}

/**
 * The plans a customer on `current` could move UP to, biggest last.
 *
 * An unknown current plan yields NOTHING rather than the whole ladder. Offering
 * "upgrade to Starter" to somebody already on Plus is worse than offering nothing.
 */
export function upgradeOptions(current: string | null | undefined): readonly HostingPlanSpec[] {
  const from = planFromCode(current);
  if (!from) return [];
  return HOSTING_PLAN_LADDER.filter((p) => p.rank > from.rank);
}

export type PlanChangeStatus = "pending" | "approved" | "rejected" | "withdrawn" | "failed";

/** Statuses of the hosting account itself, as stored. */
export type HostingStatusForChange =
  | "pending"
  | "active"
  | "suspended"
  | "expired"
  | "terminated"
  | "failed";

export interface PlanChangeFacts {
  status: PlanChangeStatus;
  /** The plan the account was on when the request was raised. */
  fromPlanCode: string | null;
  requestedPlanCode: string | null;
  /** The plan the account is on RIGHT NOW. */
  livePlanCode: string | null;
  hostingStatus: HostingStatusForChange;
  /**
   * Is this a free trial?
   *
   * ─── ADDED 11 SEP 2026, AFTER MEASURING THE HOLE ──────────────────────────
   * The portal hides the upgrade chooser on a trial, and that was the only thing
   * stopping it. Proven by calling the route directly against a trial whose
   * `plan_code` was a real one: HTTP 200, request created. Not a contrived case —
   * `provision-hosting` writes the same `Starter`/`Standard`/`Plus` names for a
   * trial as for a paid account, so any trial provisioned by the live path has an
   * identifiable plan and would have gone straight through.
   *
   * What it would have cost: a trial has no paid term. `expires_at` is null on
   * one, so the charge falls back to a FULL term and the customer is billed the
   * whole annual difference between two plans they have paid for neither of. And
   * "upgrade" on a trial is really "convert to paid" — a different conversation
   * with a different price.
   */
  isTrial: boolean;
}

export type PlanChangeVerdict =
  | { canApprove: true; from: HostingPlanSpec; to: HostingPlanSpec; daPackage: string }
  | { canApprove: false; reason: string; nextStep: string };

/**
 * May this upgrade be applied right now?
 *
 * Every refusal names what happened and what to do instead (§24). A rep looking at
 * a greyed-out Approve with no explanation will either ignore the request or do it
 * by hand at the server and forget to close it — and a plan change done by hand is
 * exactly the drift the `livePlanCode` check below exists to catch.
 */
export function assessPlanChange(f: PlanChangeFacts): PlanChangeVerdict {
  if (f.status !== "pending") {
    return {
      canApprove: false,
      reason: `This request is already ${f.status}.`,
      nextStep: "Nothing to do. Open the hosting account if the plan needs changing again.",
    };
  }

  const to = planFromCode(f.requestedPlanCode);
  if (!to) {
    return {
      canApprove: false,
      reason: `"${f.requestedPlanCode ?? "(none)"}" is not one of our hosting plans.`,
      nextStep: "Reject this request and raise a new one from the hosting account.",
    };
  }

  const live = planFromCode(f.livePlanCode);
  if (!live) {
    return {
      canApprove: false,
      reason: "We cannot tell which plan this account is on, so we cannot tell whether this is an upgrade.",
      nextStep:
        "Open the account, set its plan to match the DirectAdmin package it really has, then approve this request.",
    };
  }

  /* Before the status checks: a trial can be `active`, so a status-shaped test
     would never reach it. See `isTrial` for what this costs when it is missing. */
  if (f.isTrial) {
    return {
      canApprove: false,
      reason: "This is a free trial, so there is no paid term to move onto a bigger plan.",
      nextStep:
        "Convert the trial to a paid account on the plan the customer wants. Approving this would bill them the difference between two plans they have paid for neither of.",
    };
  }

  /* Not `active` is not approvable, and each state needs its own sentence — the
     rep's next move is different for every one of them. */
  if (f.hostingStatus !== "active") {
    const nextStep: Record<Exclude<HostingStatusForChange, "active">, string> = {
      suspended:
        "Settle whatever suspended the account and un-suspend it first — a bigger package on a suspended account changes nothing the customer can use.",
      pending:
        "This account has not been set up yet. Provision it on the plan the customer wants, rather than provisioning the old one and upgrading it.",
      expired: "Renew the account first, then approve this.",
      terminated: "This account is closed. Sell a new one on the plan the customer wants.",
      failed:
        "Provisioning never succeeded for this account, so there is nothing on the server to move. Fix the provisioning failure first.",
    };
    return {
      canApprove: false,
      reason: `This hosting account is ${f.hostingStatus}, not active.`,
      nextStep: nextStep[f.hostingStatus],
    };
  }

  /* ─── The account moved underneath the request ─────────────────────────────
     Checked BEFORE the up/down test, because the useful message here is "it
     changed since they asked", not "that is a downgrade". */
  const from = planFromCode(f.fromPlanCode);
  if (from && live.code !== from.code) {
    return {
      canApprove: false,
      reason: `The customer asked to move from ${from.name}, but the account is on ${live.name} now.`,
      nextStep:
        `Somebody changed the plan after this request was raised. Reject it and ask the customer whether they still want ${to.name} from ${live.name}.`,
    };
  }

  if (live.rank === to.rank) {
    return {
      canApprove: false,
      reason: `This account is already on ${to.name}.`,
      nextStep: "Reject the request — the customer has what they asked for. Tell them so.",
    };
  }

  if (to.rank < live.rank) {
    return {
      canApprove: false,
      reason: `${to.name} is smaller than ${live.name}, so this is a downgrade.`,
      nextStep:
        "Downgrades are not applied from here. A smaller package means a smaller disk quota and DirectAdmin applies it immediately, so it can break a site that is using the space — and the money side is a credit note, not a charge. Check the account's disk usage and handle it with the customer.",
    };
  }

  return { canApprove: true, from: live, to, daPackage: to.daPackage };
}

export interface UpgradeChargePreview {
  from: HostingPlanSpec;
  to: HostingPlanSpec;
  /** ₹/month the upgrade adds. Whole rupees, rounded once. */
  monthlyDelta: number;
  /** Days actually charged. */
  remainingDays: number;
  termDays: number;
  /** Whole rupees, before tax. */
  subtotal: number;
  tax: number;
  total: number;
}

/**
 * What to charge today for the rest of the term.
 *
 * ─── WHY THE DELTA AND NOT THE NEW PRICE ─────────────────────────────────────
 * The customer has already paid for the term on their current plan. Charging the
 * full new rate for the remaining days would bill them twice for the part they
 * already own. So the chargeable amount is the DIFFERENCE, which is also the number
 * that makes an upgrade an easy decision for them.
 *
 * Returns null rather than zero when there is nothing to charge — no remaining
 * term, or not an upgrade. Zero is a number a UI will happily render as "₹0", and
 * "this upgrade is free" is not a claim this function should be able to make by
 * accident.
 */
export function previewUpgradeCharge(args: {
  fromPlanCode: string | null;
  toPlanCode: string | null;
  remainingDays: number;
  termDays: number;
  taxRatePct: number;
}): UpgradeChargePreview | null {
  const from = planFromCode(args.fromPlanCode);
  const to = planFromCode(args.toPlanCode);
  if (!from || !to) return null;
  if (to.rank <= from.rank) return null;
  if (args.termDays <= 0 || args.remainingDays <= 0) return null;

  /* Paise for the arithmetic, exactly as proration.ts does it — the rates are
     fractional rupees and rounding per-month would drift over twelve of them. */
  const monthlyDeltaPaise = rupeesToPaise(to.monthlyRate) - rupeesToPaise(from.monthlyRate);
  if (monthlyDeltaPaise <= 0) return null;

  const r = prorate({
    annualPerSeatPaise: Math.round(monthlyDeltaPaise * 12),
    /* One hosting account, not a seat count. `prorate` is per-unit and this unit
       is the account itself. */
    seats: 1,
    remainingDays: args.remainingDays,
    termDays: args.termDays,
    taxRatePct: args.taxRatePct,
  });

  return {
    from,
    to,
    monthlyDelta: Math.round(paiseToRupees(monthlyDeltaPaise)),
    remainingDays: r.chargedDays,
    termDays: args.termDays,
    subtotal: paiseToRupees(r.subtotalPaise),
    tax: paiseToRupees(r.taxPaise),
    total: paiseToRupees(r.totalPaise),
  };
}
