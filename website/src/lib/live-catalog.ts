/**
 * Live Google Workspace prices, read from ResellerOS — the actual connection between the
 * website's product cards and the app's catalogue.
 *
 * ─── WHY LIVE, AND WHY A FALLBACK ───────────────────────────────────────────
 * The handoff shipped placeholder rates (GW Starter at ₹136/mo). The app's REAL catalogue
 * says ₹270/mo annual and ₹325/mo flexible — measured on the live DB, 31 Aug 2026. A
 * website that quotes ₹136 while the app then emails a quotation at ₹270 is the
 * document-disagrees-with-itself defect all over again, this time in front of a prospect.
 *
 * So the website reads `GET /api/public/catalog/workspace` on the app (which strips
 * wholesale — that endpoint's test proves it) and OVERRIDES the matching placeholder
 * editions. Fetched server-side with a 10-minute revalidate: a price edit in
 * Operations → Catalog reaches the website inside ten minutes with no redeploy.
 *
 * When the app is unreachable the placeholders stand and the page still renders — a
 * pricing page that 500s because an API hiccuped is worse than one that is briefly stale.
 * The merge NEVER invents: a live item without a monthly tier keeps monthly null rather
 * than deriving one, because inventing a flexible-tier price is exactly the class of
 * mistake (term boundary, 12×) the app has already paid for.
 */
import { RESELLEROS_URL } from "./config";
import { LICENCE_EDITIONS, type LicenceEdition } from "./data/catalog";

export interface LiveWorkspaceItem {
  name: string;
  annualPerSeatMo: number;
  monthlyPerSeatMo: number | null;
}

export async function fetchLiveWorkspace(): Promise<LiveWorkspaceItem[] | null> {
  try {
    const res = await fetch(`${RESELLEROS_URL}/api/public/catalog/workspace`, {
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) return null;
    const items = body.items.filter(
      (i): i is LiveWorkspaceItem =>
        !!i && typeof i === "object" &&
        typeof (i as LiveWorkspaceItem).name === "string" &&
        typeof (i as LiveWorkspaceItem).annualPerSeatMo === "number",
    );
    return items.length ? items : null;
  } catch {
    return null;
  }
}

/**
 * Overlay live GW prices onto the placeholder editions list.
 *
 * Matching is by edition suffix ("Business Starter" ↔ "GW Business Starter") — the app
 * names products "Google Workspace Business Starter", the website abbreviates. A live item
 * with no placeholder counterpart is APPENDED (a new product in the catalogue should show
 * up here, not wait for a website deploy). Matched editions get `live: true`, which the
 * calculator uses to say the price is current rather than indicative.
 */
export interface MergedEdition extends LicenceEdition {
  live?: boolean;
  /** Null when the live catalogue has no flexible tier for this product. */
  monthlyOrNull?: number | null;
}

export function mergeEditions(live: LiveWorkspaceItem[] | null): MergedEdition[] {
  const base: MergedEdition[] = LICENCE_EDITIONS.map((e) => ({ ...e, monthlyOrNull: e.monthly }));
  if (!live) return base;

  const out = [...base];
  for (const item of live) {
    const suffix = item.name.replace(/^Google Workspace\s*/i, "").trim(); // "Business Starter"
    const idx = out.findIndex((e) => e.name.toLowerCase() === `gw ${suffix}`.toLowerCase());
    const merged: MergedEdition = {
      name: idx >= 0 ? out[idx].name : `GW ${suffix}`,
      note: idx >= 0 ? out[idx].note : "From our live catalogue",
      annual: item.annualPerSeatMo,
      /* For the base `monthly: number` field a null live tier falls back to annual so the
         type holds, but `monthlyOrNull` carries the truth and the UI must read THAT. */
      monthly: item.monthlyPerSeatMo ?? item.annualPerSeatMo,
      monthlyOrNull: item.monthlyPerSeatMo,
      live: true,
    };
    if (idx >= 0) out[idx] = merged;
    else out.push(merged);
  }
  return out;
}

/** The live flexible ₹/seat/month for the entry-level GW product — the quote page's rate. */
export function liveGwMonthlyRate(live: LiveWorkspaceItem[] | null): number | null {
  if (!live?.length) return null;
  const starter = live.find((i) => /starter/i.test(i.name)) ?? live[0];
  return starter.monthlyPerSeatMo;
}
