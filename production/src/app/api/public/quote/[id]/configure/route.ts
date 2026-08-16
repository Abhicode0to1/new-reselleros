/**
 * POST /api/public/quote/[id]/configure?t=<token>
 *
 * The customer moved a seat slider or ticked an add-on. This returns the AUTHORITATIVE
 * price for that shape, and whether they may accept it themselves.
 *
 * ─── THE BROWSER SENDS A SHAPE, NEVER A PRICE ───────────────────────────────
 * The request body is a list of {lineId, seats, included}. It carries no rate, no
 * total, no discount. Everything the customer would pay is recomputed here from the
 * quote's own stored lines plus the tenant's catalogue.
 *
 * The public page has no session, so anything it posts is attacker-controlled. A total
 * sent by the browser is a total the customer chose.
 *
 * ─── AND IT NEVER RETURNS COST ──────────────────────────────────────────────
 * `configureQuote` computes margin because the approval matrix needs it — but margin,
 * cost and the approval reasons are the RESELLER's business. The response carries the
 * customer-facing price and one boolean; everything else is dropped before it reaches
 * the wire. Every field returned here is serialised into the customer's browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { configureQuote, type LineChoice } from "@/lib/quotes/configure";
import { grossAmount } from "@/lib/quotes/amounts";
import type { QuoteLineItem, Item } from "@/lib/supabase/database.types";

/** Accepts only the three fields a choice may carry — anything else is dropped. */
function parseChoices(raw: unknown): LineChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: LineChoice[] = [];
  for (const entry of raw.slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.lineId !== "string") continue;
    out.push({
      lineId: e.lineId,
      seats: typeof e.seats === "number" ? e.seats : undefined,
      included: typeof e.included === "boolean" ? e.included : undefined,
    });
  }
  return out;
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createAdminClient();

  const { data: quote } = await supabase
    .from("quotes")
    .select("id, status, tenant_id, public_token, line_items, tax_rate")
    .eq("id", params.id)
    .maybeSingle();

  // A wrong token is indistinguishable from a missing quote — no enumeration signal.
  if (!quote || !quoteTokenMatches(request.nextUrl.searchParams.get("t"), quote.public_token)) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (quote.status === "draft") {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { body = {}; }
  const choices = parseChoices((body as Record<string, unknown>)?.choices);

  const { data: catalog } = await supabase
    .from("items")
    .select("*")
    .eq("tenant_id", quote.tenant_id)
    .eq("is_active", true);

  const configured = configureQuote(
    (quote.line_items ?? []) as QuoteLineItem[],
    choices,
    (catalog ?? []) as Item[],
  );

  return NextResponse.json({
    ok: true,
    subtotal: configured.subtotal,
    total: grossAmount(configured.subtotal, quote.tax_rate ?? 18),
    changed: configured.changed,
    selfAcceptable: configured.selfAcceptable,
    lines: configured.lines.map((l) => ({
      lineId: l.line.id,
      qty: l.qty,
      included: l.included,
      rate: l.rate,
      amount: l.included ? l.qty * l.rate : 0,
      bandLabel: l.bandLabel,
      rePriced: l.rePriced,
    })),
  });
}
