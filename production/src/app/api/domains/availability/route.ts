/**
 * GET /api/domains/availability?name=&tlds=
 *
 * The search box behind the whole site. Two paths, tried in this order:
 *
 * 1. DIRECT (Plan B, 2 Sep 2026): when ResellerClub credentials are on this
 *    server, ask ResellerClub itself — availability plus the 1-year customer
 *    price — from the whitelisted static IP. This exists because the engine
 *    (app.anutech.in) cannot be redeployed: its GCP project's owner account is
 *    lost, and its public routes still 404.
 *
 * 2. ENGINE FALLBACK: without credentials (every local dev machine), proxy to
 *    the engine exactly as before, so nothing changes for local work and the
 *    old path simply resumes if it ever comes back to life.
 *
 * Merge Phase-1 replaced the hero's fake string-hash with this; the rule it
 * bought stays absolute on both paths: a failure is a stated 502 and the box
 * says "couldn't check" — never a guessed AVAILABLE, never an invented price.
 */
import { NextResponse, type NextRequest } from "next/server";
import { DOMAIN_AVAILABILITY_API } from "@/site/lib/config";
import { rcConfigured, rcAvailability, rcTldPricing } from "@/lib/resellerclub";

const DEFAULT_TLDS = ["in", "com", "co.in", "org", "net"];
const FAIL = { error: "Could not check availability right now." };

export async function GET(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim().toLowerCase();
  const tldsRaw = (req.nextUrl.searchParams.get("tlds") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Enter a domain name" }, { status: 400 });
  }
  const tlds = (tldsRaw ? tldsRaw.split(",") : DEFAULT_TLDS)
    .map((t) => t.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean)
    .slice(0, 10);

  /* ── 1. Direct: ResellerClub, from the whitelisted IP ──────────────────── */
  if (rcConfigured()) {
    const [avail, prices] = await Promise.all([rcAvailability(name, tlds), rcTldPricing(tlds)]);
    if (!avail) {
      /* Upstream said no (or the IP isn't whitelisted yet) — state it. */
      return NextResponse.json(FAIL, { status: 502 });
    }
    const priceByTld = new Map((prices ?? []).map((p) => [p.tld.replace(/^\./, ""), p]));
    /* Answer in the client's order, not ResellerClub's. */
    const byDomain = new Map(avail.map((a) => [a.domain, a]));
    const domains = tlds
      .map((tld) => {
        const a = byDomain.get(`${name}.${tld}`);
        if (!a) return null;
        const register = priceByTld.get(tld)?.register ?? null;
        return {
          domain: a.domain,
          available: a.available,
          /* Pricing can fail while availability succeeds; priceKnown=false shows
             "price on request" rather than a made-up number. */
          price: register ?? 0,
          currency: "INR",
          years: 1,
          priceKnown: a.available && register !== null,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
    return NextResponse.json({ base: name, domains, source: "resellerclub" });
  }

  /* ── 2. Fallback: the engine's public API (local dev keeps old behaviour) ── */
  const url = new URL(DOMAIN_AVAILABILITY_API);
  url.searchParams.set("name", name);
  if (tldsRaw) url.searchParams.set("tlds", tldsRaw);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
    if (!res.ok) return NextResponse.json(FAIL, { status: 502 });
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[domain-availability-proxy] upstream unreachable:", err);
    return NextResponse.json(FAIL, { status: 502 });
  }
}
