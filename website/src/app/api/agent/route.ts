/**
 * POST /api/agent — the website's bridge to the app's public AI sales agent.
 *
 * Same reason as /api/enquiry: the app's public API carries no CORS headers, so the
 * browser talks to its own origin and this route forwards server-side. It forwards the
 * messages array untouched — validation, caps, the facts page and the money guard all
 * live on the app side (production/src/lib/ai/public-sales-chat.ts), because a guard
 * split across two repos is a guard that drifts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { RESELLEROS_URL } from "@/lib/config";

const AGENT_API = `${RESELLEROS_URL}/api/public/agent/chat`;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }

  try {
    const res = await fetch(AGENT_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      /* The widget shows a typing indicator against this — a hung upstream must become a
         stated failure, not a forever-spinner. The app's own Gemini timeout is 20s. */
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "agent unavailable" }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[agent-proxy] upstream unreachable:", err);
    return NextResponse.json({ error: "agent unavailable" }, { status: 502 });
  }
}
