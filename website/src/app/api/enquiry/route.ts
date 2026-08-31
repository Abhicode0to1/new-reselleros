/**
 * POST /api/enquiry — the bridge between this website and ResellerOS.
 *
 * The quote form posts HERE, and this route forwards server-side to the app. Server-side
 * because the app's public API sends no CORS headers (checked 31 Aug 2026) — a browser
 * call would be refused; a proxy needs no app change at all.
 *
 * ─── TWO PATHS, PICKED BY WHAT WAS ASKED FOR ────────────────────────────────
 * A Google Workspace edition (Starter/Standard/Plus) goes to
 * `/api/public/enquiry/workspace` — the AUTO-QUOTE path. That endpoint creates the lead
 * AND a catalog-priced draft quotation (the same pricing module the app's checkout uses),
 * alerts the operator with a deep-link to it, and acknowledges the customer. Its
 * `draftQuoteId` comes back through us so the form can name the document.
 *
 * Everything else (M365, Zoho, Anutech Mail, Hosting, Domains) goes to
 * `/api/public/enquiry/general` — lead + notification, priced by a person. The app has no
 * auto-quote path for those vendors yet, and inventing one here would mean website-side
 * price arithmetic, which is exactly what this design avoids.
 *
 * ─── FIELD NAMES COME FROM THE APP'S SOURCE, NOT FROM MEMORY ────────────────
 * Pardeep's first real submit failed with 400 "Invalid form data: Required" because this
 * proxy sent `requirement` where the app's Zod says `message` — a field name I had
 * GUESSED after reading only the schema's first 50 lines, with a test that pinned my own
 * guess. Both schemas are now read IN FULL and site-invariants.test.ts checks this proxy
 * against the app's actual route sources; if the app's contract changes shape, the suite
 * goes red instead of visitors getting silent 400s.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ENQUIRY_API, ENQUIRY_WORKSPACE_API } from "@/lib/config";
import { gwTierFor } from "@/lib/quote-mapping";

interface EnquiryBody {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  product?: "google-workspace" | "microsoft-365" | "zoho" | "other";
  seats?: number;
  requirement?: string;
  /** The exact edition chip the visitor chose — decides the path. */
  edition?: string;
  /** annual | monthly — the workspace endpoint's `billing`. */
  term?: string;
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

  const seats =
    Number.isFinite(body.seats) && (body.seats as number) >= 1 ? Math.floor(body.seats as number) : null;
  const message =
    typeof body.requirement === "string" && body.requirement.trim()
      ? body.requirement.trim().slice(0, 2000)
      : "Quote request from the website form.";

  const tier = typeof body.edition === "string" ? gwTierFor(body.edition) : null;

  const fail = () =>
    NextResponse.json(
      { ok: false, error: "Could not record the enquiry right now. WhatsApp us and we will price it by hand." },
      { status: 502 },
    );

  const post = async (url: string, payload: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      /* A lead capture that hangs is worse than one that reports failure — the visitor is
         sitting on a submit button. */
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

  try {
    /* ── AUTO-QUOTE PATH: a GW edition with a seat count ──────────────────────
       The workspace endpoint REQUIRES seats and tierId; if either is missing the general
       path still records the lead — a degraded enquiry beats a rejected one. */
    if (tier && seats) {
      const res = await post(ENQUIRY_WORKSPACE_API, {
        fullName,
        companyName,
        email,
        phone,
        seats,
        tierId: tier,
        billing: body.term === "monthly" ? "monthly" : "annual",
        message,
      });
      if (!res.ok) {
        console.error("[enquiry-proxy] workspace upstream refused:", res.status, await res.text().catch(() => ""));
        return fail();
      }
      const data = (await res.json()) as { success?: boolean; draftQuoteId?: string | null; autoSent?: boolean };
      /* draftQuoteId can be null (doc-number retries exhausted) — the lead still exists
         and the operator was alerted, so that is a success with no number to show. */
      return NextResponse.json({ ok: true, quoteId: data.draftQuoteId ?? null, sent: data.autoSent === true });
    }

    /* ── GENERAL PATH: everything else ────────────────────────────────────── */
    const payload: Record<string, unknown> = { fullName, companyName, email, phone, message };
    if (typeof body.product === "string" && PRODUCTS.has(body.product)) payload.product = body.product;
    if (seats) payload.seats = seats;

    const res = await post(ENQUIRY_API, payload);
    if (!res.ok) {
      console.error("[enquiry-proxy] general upstream refused:", res.status, await res.text().catch(() => ""));
      return fail();
    }
    return NextResponse.json({ ok: true, quoteId: null, sent: false });
  } catch (err) {
    console.error("[enquiry-proxy] upstream unreachable:", err);
    return fail();
  }
}
