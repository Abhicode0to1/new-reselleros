/**
 * GET /api/domains/availability?name=&tlds=
 *
 * The website's bridge to the domains platform's real availability check
 * (app.anutech.in /api/public/domain-availability). Same proxy reason as
 * /api/enquiry and /api/agent — keep the platform's address in config.ts,
 * one origin for the browser, and a hung upstream becomes a stated failure
 * rather than a forever-spinner.
 *
 * Merge Phase-1: this replaces the hero search box's fake string-hash. Until
 * the platform deploys those public routes, this returns 502 and the box
 * says "couldn't check right now" — honest, never a guessed AVAILABLE/TAKEN.
 */
import { NextResponse, type NextRequest } from "next/server";
import { DOMAIN_AVAILABILITY_API } from "@/lib/config";

export async function GET(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();
  const tlds = (req.nextUrl.searchParams.get("tlds") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Enter a domain name" }, { status: 400 });
  }

  const url = new URL(DOMAIN_AVAILABILITY_API);
  url.searchParams.set("name", name);
  if (tlds) url.searchParams.set("tlds", tlds);

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "Could not check availability right now." },
        { status: 502 },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[domain-availability-proxy] upstream unreachable:", err);
    return NextResponse.json(
      { error: "Could not check availability right now." },
      { status: 502 },
    );
  }
}
