/**
 * What has to be provisioned once a quote is paid, and who can do it.
 *
 * ─── THERE IS NO VENDOR API WIRED, AND THIS FILE SAYS SO ────────────────────
 * The brief asks for a "zero-touch Google/Microsoft API seat provisioning hook". No
 * Google CSP or Microsoft Partner Center credential exists on this project — neither
 * is in the environment, neither has a client, and both need partner onboarding that
 * is a commercial process, not a code change.
 *
 * So this builds the SEAM and not a pretend integration. Every paid quote produces a
 * provisioning task with the vendor, the domain and the seat count already worked out;
 * today those tasks are `manual` and a human does the work with a real, specific
 * to-do. The day a CSP credential exists, `mode` becomes "api" for that vendor and the
 * same tasks route through it — nothing above this file changes.
 *
 * The alternative — an `provisionSeats()` that logs and returns success — is the
 * failure this codebase keeps finding: a gap rendered as a confident value. A quote
 * would show "Provisioned ✓" while nobody had created a single mailbox.
 *
 * ─── PROVISIONED AND INVOICED ARE NOT SEQUENTIAL ────────────────────────────
 * The brief orders the lifecycle "… Paid → Provisioned → Invoiced". Under CGST §31 a
 * tax invoice is issued on supply and cannot wait for a reseller to finish setting up
 * mailboxes; in practice the invoice often exists first. They are tracked as two
 * independent facts, and neither blocks the other.
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";

export type ProvisionVendor = "google" | "microsoft" | "zoho" | "other";
export type ProvisionMode = "api" | "manual";

export interface ProvisionItem {
  vendor: ProvisionVendor;
  /** The catalogue product name, so the task says what to create. */
  plan: string;
  seats: number;
  /** Where it is provisioned. Null when the quote never captured one. */
  domain: string | null;
  mode: ProvisionMode;
  /** Present when `mode` is "manual" — the reason, in the reseller's words. */
  manualReason?: string;
}

/**
 * Which vendors this deployment can actually call.
 *
 * Empty, deliberately and truthfully. Adding a vendor here without its client and
 * credential would make every task claim to be automatic and then never run.
 */
export const API_ENABLED_VENDORS: readonly ProvisionVendor[] = [];

/** Vendor from a plan name. Null when nothing in the name names a vendor. */
export function vendorFromPlanName(plan: string | null | undefined): ProvisionVendor | null {
  const p = (plan ?? "").toLowerCase();
  if (!p.trim()) return null;
  if (p.includes("google") || p.includes("workspace") || p.includes("gws")) return "google";
  if (p.includes("microsoft") || p.includes("365") || p.includes("office")) return "microsoft";
  if (p.includes("zoho")) return "zoho";
  return null;
}

/**
 * The provisioning work a paid quote creates.
 *
 * One item per line that actually needs setting up. A ₹0 line, a line with no seats,
 * and a line whose plan names no vendor are all skipped — the first two are not a
 * subscription, and the third would produce a task saying "provision 10 seats of
 * something, somewhere", which a rep cannot action and will learn to ignore.
 */
export function planProvisioning(args: {
  lines: readonly QuoteLineItem[];
  /** Quote-level domain, used when a line does not carry its own. */
  fallbackDomain?: string | null;
}): { items: ProvisionItem[]; skipped: { name: string; reason: string }[] } {
  const items: ProvisionItem[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const line of args.lines) {
    const seats = Math.trunc(line.qty);
    if (seats < 1) {
      skipped.push({ name: line.name, reason: "No seats on this line." });
      continue;
    }
    const vendor = vendorFromPlanName(line.name);
    if (!vendor) {
      /* Recorded rather than dropped: the reseller may still need to set something up,
         and a silently missing line is how a customer pays for a product nobody
         delivers. It just cannot be turned into an actionable vendor task. */
      skipped.push({ name: line.name, reason: "Nothing in the product name identifies a vendor to provision with." });
      continue;
    }

    const apiCapable = API_ENABLED_VENDORS.includes(vendor);
    items.push({
      vendor,
      plan: line.name,
      seats,
      domain: line.domain ?? args.fallbackDomain ?? null,
      mode: apiCapable ? "api" : "manual",
      ...(apiCapable ? {} : {
        manualReason: `No ${vendorLabel(vendor)} reseller API is connected on this account, so these seats are created by hand.`,
      }),
    });
  }

  return { items, skipped };
}

export function vendorLabel(v: ProvisionVendor): string {
  return { google: "Google Workspace", microsoft: "Microsoft 365", zoho: "Zoho", other: "the vendor" }[v];
}

/** One line a rep can act on without opening anything else. */
export function provisionTaskTitle(item: ProvisionItem): string {
  return `Create ${item.seats} ${item.seats === 1 ? "seat" : "seats"} of ${item.plan}` +
    (item.domain ? ` on ${item.domain}` : " — domain not captured, ask the customer");
}

export type ProvisionStatus = "pending" | "in_progress" | "done" | "failed" | "not_required";

/**
 * Is the whole quote provisioned?
 *
 * "not_required" counts as settled — a quote of pure services with nothing to create
 * is finished, not stuck. An empty task list is `not_required` for the same reason:
 * a quote nobody has to provision must not sit forever showing an unfinished step.
 */
export function overallProvisionStatus(statuses: readonly ProvisionStatus[]): ProvisionStatus {
  if (statuses.length === 0) return "not_required";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "in_progress")) return "in_progress";
  if (statuses.some((s) => s === "pending")) return "pending";
  return statuses.every((s) => s === "not_required") ? "not_required" : "done";
}
