/**
 * Which leads are website orders, what to call their channel, and where a trial stands.
 *
 * R-077 (1 Oct 2026): Online Orders listed only `source LIKE 'buy-workspace%'`, so every
 * order from the cart, the hosting trial and the DMS panel landed in the database and
 * never showed on the page meant for them. The website writes these sources (measured in
 * code, 2 Oct 2026):
 *   buy-cart-direct(-sim)       lib/checkout/cart-checkout.ts        cart checkout
 *   dms-panel                   lib/checkout/cart-checkout.ts        cart order placed from the DMS panel
 *   buy-hosting-trial           lib/hosting/start-trial.ts           hosting trial (DMS trials carry utm_source dms-panel)
 *   buy-workspace-direct(-sim)  api/public/checkout/workspace        Workspace checkout
 *   buy-workspace-trial         api/public/trial/workspace           Workspace trial
 *   buy-workspace               api/public/enquiry/workspace         Workspace enquiry
 * "-sim" is a test-mode payment. 'enquiry-form' (the general contact form) is an enquiry,
 * not an order, and stays on Leads.
 *
 * The trial clock reads the lead's own trial_started_at / trial_expires_at. It used to
 * assume 14 days from created_at for everything — the hosting trial is 15.
 */

/** PostgREST `or` filter for every website order source. */
export const WEBSITE_ORDER_FILTER = "source.like.buy-%,source.eq.dms-panel";

export function isWebsiteOrderSource(source: string | null | undefined): boolean {
  const s = source ?? "";
  return s.startsWith("buy-") || s === "dms-panel";
}

const LABELS: Record<string, string> = {
  "buy-cart-direct": "Website cart",
  "dms-panel": "DMS panel order",
  "buy-hosting-trial": "Hosting trial",
  "buy-workspace-direct": "Workspace checkout",
  "buy-workspace-trial": "Workspace trial",
  "buy-workspace": "Workspace enquiry",
};

/** "Website cart", "Hosting trial · DMS", "Website cart (test)" … — never a raw code if we know it. */
export function orderChannel(source: string | null | undefined, utmSource?: string | null): string {
  const raw = (source ?? "").trim();
  const test = raw.endsWith("-sim");
  const base = test ? raw.slice(0, -4) : raw;
  let label = LABELS[base] ?? (raw || "Website");
  if (base === "buy-hosting-trial" && utmSource === "dms-panel") label += " · DMS";
  return test ? `${label} (test)` : label;
}

export function isTrialOrder(l: { source: string | null; stage: string }): boolean {
  return (l.source ?? "").includes("trial") || l.stage === "trial";
}

export interface TrialWindow {
  /** 1-based day of the trial, capped at its length. */
  day: number;
  length: number;
  endsOn: Date;
  state: "active" | "converting" | "expired";
}

const DAY = 86_400_000;

/**
 * Where a trial stands, from the dates written on the lead. Falls back to created_at +
 * the product's published length (hosting 15, Workspace 14) only for a lead that has no
 * trial dates. "converting" = the last 3 days, when the convert call is due.
 */
export function trialWindow(
  l: { source: string | null; created_at: string; trial_started_at?: string | null; trial_expires_at?: string | null },
  now: Date = new Date(),
): TrialWindow {
  const start = new Date(l.trial_started_at ?? l.created_at);
  const fallbackLen = (l.source ?? "").includes("hosting") ? 15 : 14;
  const end = l.trial_expires_at ? new Date(l.trial_expires_at) : new Date(start.getTime() + fallbackLen * DAY);
  const length = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));
  const day = Math.max(1, Math.min(length, Math.floor((now.getTime() - start.getTime()) / DAY) + 1));
  const left = (end.getTime() - now.getTime()) / DAY;
  const state = left <= 0 ? "expired" : left <= 3 ? "converting" : "active";
  return { day, length, endsOn: end, state };
}
