/**
 * /buy/workspace/thanks?order=Q-XXX[&sim=1]
 *
 * Post-purchase confirmation page. The Buy-now dialog redirects here on
 * successful payment (live Razorpay capture OR simulation). The page reads
 * the quote by ID via the admin client and renders a clear "what happens
 * next" timeline + WhatsApp Pardeep CTA.
 *
 * Security posture
 *   Quote IDs (Q-2025-26-NNNN) are guessable, so we ONLY render order
 *   details when:
 *     • the quote belongs to BUY_PAGE_TENANT_ID (ANUTECH's tenant)
 *     • payment_status is 'received' (paid) or 'partial'
 *   Anything else → friendly fallback page with no leaked data.
 */
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { ThanksClient, type ThanksOrder } from "./thanks-client";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const metadata: Metadata = {
  title: "Order confirmed · ResellerOS",
  description: "Your Google Workspace order is confirmed. Pardeep will WhatsApp you within 4 hours to verify your domain.",
};

// Don't cache — different visitor = different order
export const dynamic = "force-dynamic";

/** Pull only the customer-safe slice of the quote row. Never expose cost,
 *  margin, internal notes, or other tenant data. */
async function fetchOrder(quoteId: string): Promise<ThanksOrder | null> {
  if (!/^Q-[0-9]{4}-[0-9]{2}-[0-9]{4}$/.test(quoteId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("quotes")
    .select("id, tenant_id, customer_name, plan, seats, amount, payment_status, payment_received_at, line_items, created_date")
    .eq("id", quoteId)
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .in("payment_status", ["received", "partial"])
    .maybeSingle();
  if (error || !data) return null;

  // Extract tier name + domain from line_items / notes if present.
  const firstLine = Array.isArray(data.line_items) && data.line_items.length > 0
    ? (data.line_items[0] as { name?: string })
    : null;
  const tierName = firstLine?.name?.replace(/^Google Workspace\s*[·\-]?\s*/i, "").replace(/\s*\(annual\)\s*$/i, "")
                ?? data.plan
                ?? "Google Workspace";

  return {
    quoteId:        data.id,
    customerName:   data.customer_name ?? "",
    tierName,
    seats:          data.seats ?? 0,
    amount:         data.amount ?? 0,
    paymentStatus:  data.payment_status ?? "awaiting",
    paymentDate:    data.payment_received_at ?? data.created_date ?? null,
  };
}

export default async function ThanksPage({
  searchParams,
}: {
  searchParams: { order?: string; sim?: string };
}) {
  const quoteId = (searchParams.order ?? "").trim();
  const order   = quoteId ? await fetchOrder(quoteId) : null;
  const isSim   = searchParams.sim === "1";

  return <ThanksClient order={order} isSimulation={isSim} />;
}
