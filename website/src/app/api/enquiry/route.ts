/**
 * POST /api/enquiry — the bridge between this website and ResellerOS.
 *
 * The quote form posts HERE, and this route forwards server-side to the app's public
 * lead-capture API (`/api/public/enquiry/general`). Why a proxy and not a direct browser
 * call: the app's public API sends no CORS headers (checked 31 Aug 2026 — no
 * `Access-Control-*` anywhere under src/app/api/public), so a cross-origin fetch from this
 * site would be refused by the browser. Server-to-server has no CORS, and it also keeps the
 * app's URL out of the page source.
 *
 * What happens on the other side: the app creates a `leads` row in the ANUTECH tenant
 * (stage "new", source "enquiry-form") and notifies the operator. From there the app's own
 * machinery — the AI sales agent, auto-quote, follow-up tasks — takes over. This is the
 * whole point of the website: every quote generated here becomes a lead there.
 *
 * Validation here is deliberately the same shape the app enforces (Zod on that side):
 * forwarding junk just to have it rejected across the network wastes the visitor's time
 * with a worse error message.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ENQUIRY_API } from "@/lib/config";

interface EnquiryBody {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  product?: "google-workspace" | "microsoft-365" | "zoho" | "other";
  seats?: number;
  requirement?: string;
}

const PRODUCTS = new Set(["google-workspace", "microsoft-365", "zoho", "other"]);

export async function POST(req: NextRequest) {
  let body: Partial<EnquiryBody>;
  try {
    body = (await req.json()) as Partial<EnquiryBody>;
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  const fullName = String(body.fullName ?? "").trim();
  const companyName = String(body.companyName ?? "").trim();
  const email = String(body.email ?? "").trim();
  const phone = String(body.phone ?? "").trim();

  if (fullName.length < 2 || companyName.length < 2 || !email.includes("@") || phone.length < 10) {
    return NextResponse.json(
      { ok: false, error: "Name, company, a valid email and a 10-digit phone are required." },
      { status: 400 },
    );
  }

  const payload: Record<string, unknown> = { fullName, companyName, email, phone };
  if (typeof body.product === "string" && PRODUCTS.has(body.product)) payload.product = body.product;
  if (Number.isFinite(body.seats) && (body.seats as number) >= 1) payload.seats = Math.floor(body.seats as number);
  /* ── FIELD KA NAAM 'message' HAI, 'requirement' NAHI ──────────────────────
     Pardeep ke pehle asli submit par upstream ne 400 diya: "Invalid form data: Required".
     App ka Zod free-text ko `message` (required, min 5) kehta hai; maine schema ki
     pehli 50 line padh kar naam ANDAZE se likha tha, aur mera test mere hi andaze ko pin
     kar raha tha. Ab ye naam app ke route-source se test hota hai (site-invariants) —
     wahan ka schema badle to yahan laal hoga, chupchaap 400 nahi. */
  const message = typeof body.requirement === "string" && body.requirement.trim()
    ? body.requirement.trim().slice(0, 2000)
    : "Quote request from the website form.";
  payload.message = message;

  try {
    const res = await fetch(ENQUIRY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      /* A lead capture that hangs is worse than one that reports failure — the visitor is
         sitting on a submit button. */
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[enquiry-proxy] upstream refused:", res.status, await res.text().catch(() => ""));
      return NextResponse.json(
        { ok: false, error: "Could not record the enquiry right now. WhatsApp us and we will price it by hand." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[enquiry-proxy] upstream unreachable:", err);
    return NextResponse.json(
      { ok: false, error: "Could not record the enquiry right now. WhatsApp us and we will price it by hand." },
      { status: 502 },
    );
  }
}
