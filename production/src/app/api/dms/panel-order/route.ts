/**
 * POST /api/dms/panel-order — a purchase made inside the DMS customer panel.
 *
 * Owner decision 30 (25 Sep 2026): ResellerOS creates every Razorpay order. DMS's
 * `?buy=hosting` / `?buy=domain` dialogs call this server-to-server, then open
 * Razorpay with the `razorpayKeyId` and `orderId` it returns. Payment lands on
 * ResellerOS's Razorpay webhook, which records it, and queues provisioning through the
 * DMS engine, exactly as for a site cart sale.
 *
 * Priced by the SAME function as the site cart (lib/checkout/cart-checkout.ts), so the
 * browser's prices are never trusted here either.
 *
 * Body: the site cart's body plus `dmsUserId`, the DMS account the purchase came from.
 * It is recorded on the lead and on the Razorpay order.
 *
 * When ResellerOS is down, DMS gets no answer and must refuse the purchase: there is no
 * DMS fallback order (decision 30 replaced decision 16's "take payment, bill later").
 */
import { NextResponse, type NextRequest } from "next/server";
import { runCartCheckout } from "@/lib/checkout/cart-checkout";
import { checkPanelKey } from "@/lib/dms-engine/panel-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = checkPanelKey(request.headers);
  if (!auth.ok) {
    if (auth.status === 503) console.warn("[dms/panel-order]", auth.error);
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid panel order: the request was not JSON. Nothing was charged." }, { status: 400 });
  }
  const dmsUserId = (body as { dmsUserId?: unknown } | null)?.dmsUserId;
  if (typeof dmsUserId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(dmsUserId)) {
    return NextResponse.json(
      { error: "Invalid panel order: `dmsUserId` must name the DMS account the purchase is made from. Nothing was charged." },
      { status: 400 },
    );
  }
  return runCartCheckout(request, body, { kind: "dms-panel", dmsUserId });
}
