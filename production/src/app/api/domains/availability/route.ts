/**
 * GET /api/domains/availability?name=&tlds=
 *
 * The search box behind the whole site. The lookup itself lives in
 * `lib/domains/live-lookup.ts` since 24 Sep 2026, because the checkout now
 * charges the SAME live price this shows (owner decision 19) — one
 * implementation, so the shown price and the charged price cannot drift.
 *
 * The rule it has always kept stays absolute: a failure is a stated 502 and the
 * box says "couldn't check" — never a guessed AVAILABLE, never an invented price.
 */
import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_TLDS, cleanTlds, lookupDomains } from "@/lib/domains/live-lookup";

const FAIL = { error: "Could not check availability right now." };

export async function GET(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim().toLowerCase();
  const tldsRaw = (req.nextUrl.searchParams.get("tlds") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Enter a domain name" }, { status: 400 });
  }
  const tlds = cleanTlds(tldsRaw ? tldsRaw.split(",") : DEFAULT_TLDS);

  const out = await lookupDomains(name, tlds);
  if (!out.ok) return NextResponse.json(FAIL, { status: 502 });
  return NextResponse.json({ base: out.base, domains: out.domains, source: out.source });
}
