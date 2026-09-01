/**
 * GET /api/integrations/google-reseller/subscriptions
 *
 * Pulls ALL of the reseller's Google Workspace subscriptions live from the
 * Reseller API, using the signed-in user's Google OAuth token (same machinery
 * as the Google Contacts import). Returns normalized rows the subscriptions
 * "Add missing from Google" matcher can classify + import.
 *
 * Owner does this ONCE in Google Cloud Console (we can't — it's their account):
 *   1. Enable "Google Workspace Reseller API" in the OAuth project.
 *   2. OAuth consent screen → add scope:
 *        https://www.googleapis.com/auth/apps.order.readonly
 *   3. Re-login to ResellerOS with the reseller-admin Google account so the
 *      token carries the new scope.
 *
 * Read-only: this NEVER writes to Google or the DB. It only reads subscriptions.
 *
 * Docs: https://developers.google.com/workspace/admin/reseller/reference/rest/v1/subscriptions/list
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Minimal shape of the Reseller API Subscription resource (only fields we use).
interface ResellerSub {
  customerId?: string;
  customerDomain?: string;
  skuId?: string;
  skuName?: string;
  status?: string;        // ACTIVE | SUSPENDED | PENDING | ...
  creationTime?: string;  // epoch ms (string)
  seats?: { numberOfSeats?: number; licensedNumberOfSeats?: number; maximumNumberOfSeats?: number };
  plan?: { planName?: string; commitmentInterval?: { startTime?: string; endTime?: string } };
  renewalSettings?: { renewalType?: string };
}
interface ResellerListResponse {
  subscriptions?: ResellerSub[];
  nextPageToken?: string;
}

// What the client matcher consumes (mirrors RawSub in google-subs-parse.ts).
interface NormalizedSub {
  domain: string;
  sku: string;
  seats: number;
  status: "active" | "paused";
  start_date?: string;
  renewal_date?: string;
}

function msToISO(ms?: string): string | undefined {
  if (!ms) return undefined;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  // probe=1 → lightweight status check (1 row) for the Settings card; no full pull.
  const probe = new URL(req.url).searchParams.get("probe") === "1";

  const supabase = createClient();
  /* Pehchan getUser() se — wo JWT ko SERVER par verify karta hai; getSession()
     cookie par bharosa karta hai (middleware.ts:47 isi wajah se getUser hai —
     audit C8 ne yahan do chhoote hue pakde). provider_token phir bhi session
     se hi milta hai, isliye dono call hain: getUser = darwaza, getSession =
     Google ka token. */
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: { session } } = await supabase.auth.getSession();

  const accessToken = session?.provider_token;
  if (!accessToken) {
    return NextResponse.json(
      { error: "Google access token unavailable — log in with your reseller-admin Google account.", code: "needs_reauth" },
      { status: 403 },
    );
  }

  const out: NormalizedSub[] = [];
  let pageToken: string | undefined;
  let skipped = 0;

  try {
    do {
      const url = new URL("https://reseller.googleapis.com/apps/reseller/v1/subscriptions");
      url.searchParams.set("maxResults", probe ? "1" : "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        // API not enabled in the Cloud project → actionable, distinct from auth.
        if (res.status === 403 && /(accessNotConfigured|has not been used|is disabled|SERVICE_DISABLED)/i.test(txt)) {
          return NextResponse.json(
            {
              error: "Reseller API isn't enabled yet. In Google Cloud Console → APIs & Services, enable \"Google Workspace Reseller API\", then try again.",
              code: "api_disabled",
              detail: txt.slice(0, 400),
            },
            { status: 403 },
          );
        }
        // Token expired or scope (apps.order.readonly) not granted → re-auth.
        if (res.status === 401 || res.status === 403) {
          return NextResponse.json(
            {
              error: "Google rejected the request. Re-login and grant the reseller (apps.order.readonly) scope.",
              code: "needs_reauth",
              detail: txt.slice(0, 400),
            },
            { status: 403 },
          );
        }
        return NextResponse.json(
          { error: `Reseller API error: ${res.status}`, detail: txt.slice(0, 400) },
          { status: 502 },
        );
      }

      const data = (await res.json()) as ResellerListResponse;
      if (probe) {
        return NextResponse.json({ connected: true, mode: "live" });
      }
      for (const s of data.subscriptions ?? []) {
        const domain = (s.customerDomain ?? "").trim();
        const sku = (s.skuName ?? "").trim();
        if (!domain || !sku || /cloud identity free/i.test(sku)) { skipped++; continue; }
        out.push({
          domain,
          sku,
          seats: Math.max(0, Math.round(s.seats?.numberOfSeats ?? s.seats?.licensedNumberOfSeats ?? 0)),
          status: /active/i.test(s.status ?? "") ? "active" : "paused",
          start_date: msToISO(s.creationTime),
          renewal_date: msToISO(s.plan?.commitmentInterval?.endTime),
        });
      }
      pageToken = data.nextPageToken;
      if (out.length >= 20000) break;   // runaway guard
    } while (pageToken);

    return NextResponse.json({ subscriptions: out, total: out.length, skipped, mode: "live" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fetch failed" },
      { status: 500 },
    );
  }
}
