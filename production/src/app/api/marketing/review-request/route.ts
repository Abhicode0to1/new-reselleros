/**
 * POST /api/marketing/review-request  { customerId, force? }
 *
 * Emails one customer the company's Google review link and logs it in review_requests
 * (migration 20260926220000). Refuses — sends nothing — when there is no review link, no
 * email on the customer, or the customer was asked in the last 30 days (unless force).
 *
 * Runs as the signed-in user: the customer, the link and the log all go through RLS, so a
 * user can only ask their own company's customers.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { replyToAddress } from "@/lib/email/reply-to";
import { isValidReviewLink, reviewEmail, tooSoon, REVIEW_COOLDOWN_DAYS } from "@/lib/marketing/review-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ customerId: z.string().uuid(), force: z.boolean().optional() });

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Customer chuno." }, { status: 400 });
  const { customerId, force } = parsed.data;

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", auth.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "Aapka account kisi company se juda nahi hai." }, { status: 403 });

  /* Tables newer than the generated types are read untyped (database.types.ts is shared). */
  const db = supabase as unknown as { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any

  const { data: customer } = await supabase.from("customers")
    .select("id, name, display_name, contact_name, contact_first_name, contact_email")
    .eq("id", customerId).single();
  if (!customer) return NextResponse.json({ error: "Customer nahi mila." }, { status: 404 });
  const to = (customer.contact_email ?? "").trim();
  if (!to) return NextResponse.json({ error: "Is customer ki email nahi hai — WhatsApp se bhejo ya email jodo." }, { status: 400 });

  const { data: tool } = await db.from("marketing_tools").select("review_link").eq("tool_key", "google-business").maybeSingle();
  const link = (tool?.review_link ?? "").trim();
  if (!isValidReviewLink(link)) {
    return NextResponse.json({ error: "Pehle Google review link save karo (upar wala box)." }, { status: 400 });
  }

  if (!force) {
    const { data: last } = await db.from("review_requests").select("created_at")
      .eq("customer_id", customerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (tooSoon(last?.created_at)) {
      return NextResponse.json(
        { error: `Is customer ko pichhle ${REVIEW_COOLDOWN_DAYS} din mein poocha ja chuka hai.`, code: "too_soon" },
        { status: 409 },
      );
    }
  }

  const { data: tenant } = await supabase.from("tenants").select("name, email").eq("id", me.tenant_id).single();
  const { data: boxes } = await supabase.from("user_google_tokens").select("google_email").eq("tenant_id", me.tenant_id);
  const sender = tenant?.name ?? "Our team";
  const msg = reviewEmail({
    contactName: customer.contact_first_name || customer.contact_name,
    company: customer.display_name || customer.name,
    sender, link,
  });

  const result = await sendEmail({
    to,
    from: process.env.RESEND_FROM_DEFAULT?.trim() || undefined,
    replyTo: replyToAddress(boxes, tenant?.email),
    route: { tenantId: me.tenant_id },
    kind: "review_request",
    subject: msg.subject, text: msg.text, html: msg.html,
  });

  const status = result.status === "failed" ? "failed" : result.status === "stubbed" ? "stubbed" : "sent";
  await db.from("review_requests").insert({
    tenant_id: me.tenant_id, customer_id: customerId, channel: "email", sent_to: to,
    status, error: result.status === "failed" ? (result.errorMessage ?? "failed") : null, created_by: auth.user.id,
  });

  if (status === "failed") return NextResponse.json({ error: result.errorMessage ?? "Mail nahi gaya." }, { status: 502 });
  return NextResponse.json({ ok: true, status, to });
}
