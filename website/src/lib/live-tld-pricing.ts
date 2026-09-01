/**
 * Live TLD rate card, read from the domains platform (app.anutech.in) — the
 * sibling of live-catalog.ts, for the /domains and /pricing rate tables.
 *
 * ─── WHY LIVE, AND WHY A FALLBACK ───────────────────────────────────────────
 * catalog.ts TLDS ships placeholder register/renew/transfer prices that had
 * already drifted from what the shop charges (the same defect live-catalog
 * fixed for Google Workspace). This reads GET /api/public/tld-pricing on the
 * platform and OVERRIDES the matching placeholder TLD with the real customer
 * price, server-side, 10-minute revalidate — a price change in the platform's
 * admin reaches the site within ten minutes, no redeploy.
 *
 * When the platform is unreachable, the placeholder stands and the page still
 * renders (a rate table that 500s on an API hiccup is worse than a briefly
 * stale one). It NEVER invents: a missing real price keeps the placeholder and
 * is NOT marked live, so the UI can show which rows are current.
 */
import { TLD_PRICING_API } from "./config";
import { TLDS, type Tld } from "./data/catalog";

export interface LiveTldPrice {
  tld: string; // ".in"
  register: number | null;
  renew: number | null;
  transfer: number | null;
  currency: string;
}

export async function fetchLiveTldPricing(tlds: readonly string[]): Promise<LiveTldPrice[] | null> {
  try {
    // API wants dot-less, comma-separated ("in,com,co.in").
    const q = tlds.map((t) => t.replace(/^\.+/, "")).join(",");
    const res = await fetch(`${TLD_PRICING_API}?tlds=${encodeURIComponent(q)}`, {
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tlds?: unknown };
    if (!Array.isArray(body.tlds)) return null;
    const rows = body.tlds.filter(
      (r): r is LiveTldPrice =>
        !!r && typeof r === "object" && typeof (r as LiveTldPrice).tld === "string",
    );
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

export interface MergedTld extends Tld {
  /** True only when a real register price came from the platform. */
  live?: boolean;
}

/**
 * Overlay live prices onto the placeholder TLDS, keyed by tld string. Only the
 * fields the platform actually returned override — a null real price leaves the
 * placeholder in place and does NOT flip `live`, so the page never shows an
 * invented number dressed as current.
 */
export function mergeTlds(live: LiveTldPrice[] | null): MergedTld[] {
  if (!live) return TLDS.map((t) => ({ ...t }));
  const byTld = new Map(live.map((r) => [r.tld.toLowerCase(), r]));
  return TLDS.map((t) => {
    const r = byTld.get(t.tld.toLowerCase());
    if (!r || r.register == null) return { ...t };
    return {
      ...t,
      reg: r.register,
      renew: r.renew ?? t.renew,
      transfer: r.transfer ?? t.transfer,
      live: true,
    };
  });
}
