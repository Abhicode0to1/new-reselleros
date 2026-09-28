/**
 * POST /api/quotes/[id]/mark-accepted
 *
 * Operator-triggered "customer accepted but hasn't paid yet" flow.
 *
 * Common B2B scenario:
 *   Customer says "yes, send invoice" but their finance dept takes 5-30 days
 *   to actually wire the money. Without this endpoint Pardeep had to wait
 *   for the payment to land before the lead converted to a customer record,
 *   which made follow-up + KPIs blind to in-flight deals.
 *
 * This calls the accept_quote() RPC which:
 *   - Sets quote.status = 'accepted'
 *   - Converts lead → customer (if linked + not already converted)
 *   - Marks lead.stage = 'won'
 *   - DOES NOT create payment / receipt voucher / subscription
 *     (those land via record_payment when the money actually arrives)
 *
 * Returns: { customerId, convertedNow, awaitsPayment }
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("accept_quote", {
    p_quote_id: params.id,
  });
  if (error) {
    const code = error.code === "PGRST116" ? 404 : 400;
    return NextResponse.json({ error: error.message }, { status: code });
  }

  type AcceptResult = {
    quote_id:       string;
    customer_id:    string;
    converted_now:  boolean;
    quote_status:   string;
    awaits_payment: boolean;
  };
  const result = data as unknown as AcceptResult;

  return NextResponse.json({
    quoteId:       result.quote_id,
    customerId:    result.customer_id,
    convertedNow:  result.converted_now,
    quoteStatus:   result.quote_status,
    awaitsPayment: result.awaits_payment,
  });
}
