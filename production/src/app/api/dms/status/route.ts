import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getEngineHealth,
  isEngineConfigured,
  dmsPanelUrl,
} from "@/lib/dms-engine/client";

/**
 * GET /api/dms/status — is the DMS hosting/domains engine reachable, and where
 * do we send a person who wants to work in it?
 *
 * DMS (app.anutech.in) keeps its own customer portal and admin panel and keeps
 * doing the provisioning. This route exists so a staff page here can say
 * honestly whether that app is up before offering a link into it — a dead link
 * to a panel somebody relies on is worse than a visible "engine unreachable".
 *
 * ─── WHY THE ENGINE KEY NEVER LEAVES THE SERVER ──────────────────────────────
 * `lib/dms-engine/client` is `server-only` and holds `DMS_ENGINE_READ_KEY`.
 * The browser calls THIS route, which is authenticated by the caller's own
 * Supabase session; the engine key is used server-side and never serialised
 * into a response. Shipping it to the client would hand every logged-in user a
 * credential for another application.
 *
 * ─── SIGNED-IN IS THE ONLY GATE, DELIBERATELY ────────────────────────────────
 * No role check. The response carries no customer data — a reachability flag,
 * two booleans about which upstreams are configured, and two URLs that are
 * already public addresses. Gating it by role would imply it holds something
 * sensitive and invite someone to put something sensitive in it later. If that
 * changes, the gate must change with it.
 */
export async function GET(_request: NextRequest) {
  const supabase = createClient();

  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Not configured is a first-class answer, not a failure: on a fresh checkout
  // or a local box with a blank .env this is the EXPECTED state, and the page
  // should say "not connected yet" rather than "something went wrong".
  if (!isEngineConfigured()) {
    return NextResponse.json({
      configured: false,
      reachable: false,
      reason: "not_configured",
      panelUrls: { admin: null, customer: null },
    });
  }

  const result = await getEngineHealth();

  if (!result.ok) {
    return NextResponse.json({
      configured: true,
      reachable: false,
      reason: result.reason,
      // Still hand back the panel links. They are derived from our own config,
      // not from the engine's reply, so they remain correct even when DMS is
      // down — and a human who wants to go and look at a broken app should not
      // be blocked from reaching it by this page.
      panelUrls: { admin: dmsPanelUrl("admin"), customer: dmsPanelUrl("customer") },
    });
  }

  return NextResponse.json({
    configured: true,
    reachable: true,
    contractVersion: result.data.contractVersion,
    database: result.data.database,
    capabilities: result.data.capabilities,
    // Prefer what the engine reports about itself — it knows its own public
    // address, and if the two disagree that is a misconfiguration worth seeing
    // rather than papering over.
    panelUrls: {
      admin: result.data.panelUrls?.admin || dmsPanelUrl("admin"),
      customer: result.data.panelUrls?.customer || dmsPanelUrl("customer"),
    },
  });
}
