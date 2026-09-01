import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/catalog/sync-hosting — pull the hosting tiers from the DMS engine
 * (app.anutech.in, GET /api/public/hosting-plans) into THIS tenant's catalogue.
 *
 * Why a route and not a client call: the plan feed lives on another origin, so
 * the fetch belongs server-side (no CORS dance, no leaking of internal URLs to
 * the browser). The actual write is the `sync_hosting_catalog` RPC, which is
 * atomic, idempotent, and owner-only — so this route does not re-implement any
 * of that; it authenticates, fetches, and hands the plans to the RPC. A
 * non-owner (or an unauthenticated caller) is refused by the RPC / RLS.
 *
 * Live only once the DMS is deployed and its public API answers; until then the
 * fetch fails and we return a clear 502, never a half-written catalogue.
 */

const DMS_BASE = (process.env.DOMAINS_APP_URL ?? "https://app.anutech.in").replace(/\/+$/, "");
const HOSTING_PLANS_API = `${DMS_BASE}/api/public/hosting-plans`;

interface DmsHostingPlan {
  planId: string;
  name: string;
  description?: string;
  price: number;
  renewalPrice?: number;
  currency?: string;
  period?: string;
  features?: string[];
  quotaMB?: number;
  bandwidthMB?: number;
  popular?: boolean;
}

export async function POST(_request: NextRequest) {
  const supabase = createClient();

  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // 1. Fetch the plans from the engine.
  let plans: DmsHostingPlan[];
  try {
    const res = await fetch(HOSTING_PLANS_API, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Hosting engine returned ${res.status}. Is app.anutech.in deployed?` },
        { status: 502 },
      );
    }
    const body = (await res.json()) as { plans?: unknown };
    if (!Array.isArray(body.plans)) {
      return NextResponse.json({ error: "Hosting engine sent no plans." }, { status: 502 });
    }
    plans = body.plans as DmsHostingPlan[];
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the hosting engine (app.anutech.in). Try again once it's deployed." },
      { status: 502 },
    );
  }

  if (plans.length === 0) {
    return NextResponse.json({ synced: 0, message: "The engine has no active hosting plans yet." });
  }

  // 2. Hand them to the atomic, owner-only RPC.
  const { data: count, error } = await supabase.rpc("sync_hosting_catalog", {
    p_plans: plans as unknown as never,
  });
  if (error) {
    const status = error.message.toLowerCase().includes("owner") ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ synced: count ?? 0 });
}
