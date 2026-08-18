/**
 * Folders for /subscriptions — and they ADD UP.
 *
 * ─── WHY THE OLD TABS CONFUSED PEOPLE ───────────────────────────────────────
 * The page offered All · Active · Trials · Expiring 30d · Expired, and three of those
 * OVERLAP: an active subscription renewing in twenty days is counted in Active AND in
 * Expiring 30d. Numbers side by side get added — Pardeep did exactly that with the leads
 * chips ("open 8, inbox 7, hot 2 — ye kaise sahi ho sakta hai") and the same arithmetic
 * fails here.
 *
 * So the four lifecycle folders below are a PARTITION: every subscription is in exactly
 * one, and they sum to the total. Anything that is a lens rather than a stage — vendor
 * mismatch — is labelled a FILTER and counted apart, the same split that fixed /leads.
 *
 * ─── AND "SUSPENDED" IS THIS SCHEMA'S `paused` ──────────────────────────────
 * There is no `suspended` value: `sub_status` is active | paused | expired | cancelled, and
 * the dunning cron writes `status = 'paused'` with a `suspended_at` stamp when it cuts
 * service off (api/cron/invoice-dunning/route.ts:174). The folder is called Suspended
 * because that is what it means to the customer, and `suspended_at` is what tells an
 * automatic cut-off apart from somebody pausing a subscription by hand — a distinction
 * worth keeping, because one is a debt and the other is a favour.
 */

export type SubFolder = "active" | "expiring" | "suspended" | "ended";

export interface SubFolderMeta {
  id: SubFolder;
  label: string;
  /** One line of plain English, shown when the folder is empty. */
  hint: string;
  dot?: "emerald" | "amber" | "rose" | "slate";
}

/**
 * In lifecycle order, because that is the order a reseller worries in: what is fine, what
 * needs chasing this month, what has been cut off, what is over.
 */
export const SUB_FOLDERS: readonly SubFolderMeta[] = [
  { id: "active",    label: "Active",    dot: "emerald", hint: "Live subscriptions with more than 30 days to run." },
  { id: "expiring",  label: "Expiring",  dot: "amber",   hint: "Nothing renews in the next 30 days." },
  { id: "suspended", label: "Suspended", dot: "rose",    hint: "Nothing is cut off — no customer has lost service." },
  { id: "ended",     label: "Ended",     dot: "slate",   hint: "Expired and cancelled subscriptions collect here. Nothing is deleted." },
] as const;

/** Days from `today` until the renewal. Null when there is no date to count to. */
export function daysToRenewal(renewalDate: string | null | undefined, todayISO: string): number | null {
  if (!renewalDate) return null;
  const a = Date.parse(`${todayISO.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${renewalDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  /* Whole days by DATE, not elapsed hours — otherwise a subscription moves folder
     depending on the time of day the page is opened. */
  return Math.round((b - a) / 86_400_000);
}

/** How close to renewal counts as "expiring". One month: the window a reseller acts in. */
export const EXPIRING_WINDOW_DAYS = 30;

export interface FolderRow {
  status: string | null;
  renewal_date: string | null;
}

/**
 * The ONE folder this subscription belongs to.
 *
 * Ordered by what matters most: cut off beats expiring beats active, because a suspended
 * subscription whose renewal is also near is a suspension first — the customer has no
 * service, and telling them about a renewal would be absurd.
 */
export function folderOf(row: FolderRow, todayISO: string): SubFolder {
  if (row.status === "paused")                       return "suspended";
  if (row.status === "expired" || row.status === "cancelled") return "ended";

  const d = daysToRenewal(row.renewal_date, todayISO);
  /* A renewal date already in the past on a row still marked active is a lapse nobody
     processed. It belongs with Expiring, not Active: it is the most urgent thing on the
     page, and filing it under Active would hide it behind a green dot. */
  if (d !== null && d <= EXPIRING_WINDOW_DAYS) return "expiring";
  return "active";
}

/** Every folder's count. Sums to `rows.length` — that is the point. */
export function folderCounts(
  rows: readonly FolderRow[],
  todayISO: string,
): Record<SubFolder, number> {
  const counts: Record<SubFolder, number> = { active: 0, expiring: 0, suspended: 0, ended: 0 };
  for (const r of rows) counts[folderOf(r, todayISO)]++;
  return counts;
}

/**
 * ₹/month at risk in a folder.
 *
 * Only the folders where the money is still live. An ended subscription's MRR is not "at
 * risk", it is gone, and adding it to a risk figure would make the number meaningless.
 */
export function folderMrr(
  rows: readonly (FolderRow & { mrr: number | null })[],
  folder: SubFolder,
  todayISO: string,
): number {
  return rows
    .filter((r) => folderOf(r, todayISO) === folder)
    .reduce((sum, r) => sum + (r.mrr ?? 0), 0);
}

/**
 * Was this suspension automatic, or did somebody pause it on purpose?
 *
 * A cut-off for non-payment is a debt to collect; a manual pause is usually a favour
 * granted to a customer between projects. Presenting them the same way would have a rep
 * chasing money from somebody who was told not to pay.
 */
export function suspensionKind(row: { suspended_at?: string | null }): "auto-unpaid" | "manual" {
  return row.suspended_at ? "auto-unpaid" : "manual";
}
