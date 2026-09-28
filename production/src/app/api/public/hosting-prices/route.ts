/**
 * GET /api/public/hosting-prices — ResellerOS's hosting prices, as checkout charges them.
 *
 * Owner, 28 Sep 2026: the DMS panel reads prices live from ResellerOS instead of keeping a
 * copy. These are the public list prices the /hosting page shows, so no key is needed; the
 * figures come from lib/checkout/hosting-prices.ts, the same function checkout charges with.
 * Whole rupees; `inclGst` adds 18% GST the way checkout does.
 */
import { NextResponse } from "next/server";
import { HOSTING_GST_RATE, hostingPriceTable } from "@/lib/checkout/hosting-prices";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { gstRate: HOSTING_GST_RATE, plans: hostingPriceTable() },
    // A price change reaches the panel within a minute; a cache never holds one longer.
    { headers: { "cache-control": "public, max-age=0, s-maxage=60" } },
  );
}
