/**
 * POST /api/public/checkout/cart — the site cart's checkout.
 *
 * The logic lives in lib/checkout/cart-checkout.ts since 25 Sep 2026, because the DMS
 * panel's orders (POST /api/dms/panel-order) must be priced by exactly the same code
 * (owner decision 30). Read that file's header for the money rules.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runCartCheckout } from "@/lib/checkout/cart-checkout";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid checkout: the request was not JSON. Nothing was charged." }, { status: 400 });
  }
  return runCartCheckout(request, body, { kind: "site" });
}
