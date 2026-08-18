/**
 * POST /api/inbound-emails/[id]/reply — answer an enquiry from the inbox.
 *
 * ─── THE TENANT COMES FROM THE SESSION, NEVER FROM THE BODY ─────────────────
 * Same posture as the sibling /state route, and it matters more here: this sends mail in
 * the reseller's name. A route that took the tenant from the request would let anyone with
 * the URL email a stranger's customers as that stranger.
 *
 * The enquiry is then loaded scoped by id AND tenant_id. The admin client bypasses RLS, so
 * an id on its own is a valid key to any row in the table — belt and braces.
 *
 * ─── THE RECIPIENT IS THE STORED SENDER, NOT ANYTHING THE CALLER SENDS ──────
 * The body carries a subject and a message. It does NOT carry a `to`, deliberately.
 * Accepting one would turn an authenticated inbox into an open relay sending from a
 * verified domain — the single most abusable shape an endpoint like this can have. The
 * address comes off the enquiry row and nowhere else.
 *
 * ─── AND THE SEND IS ITS OWN RECORD ─────────────────────────────────────────
 * No row is written here. sendEmail() already writes email_log from inside itself
 * (lib/email/log.ts explains why the write lives there and not at the call site), and
 * `kind: "enquiry_reply"` plus the recipient is enough for the screen to derive "you have
 * already answered this" — the same derived-not-stored rule as lib/inbound/answered.ts.
 * A second bookkeeping write here could fail on its own and would then disagree with the
 * log about whether an email that has already left ever happened.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  subject: z.string().trim().min(1).max(300),
  /* Long enough for a real reply, bounded so a paste-bomb cannot be relayed. */
  body:    z.string().trim().min(1).max(20_000),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json(
      { error: "Your account is not linked to a workspace yet — an owner can claim it on the Team page." },
      { status: 403 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "A subject and a message are both required." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: enquiry } = await admin
    .from("inbound_emails")
    .select("id, tenant_id, from_email, subject")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!enquiry) {
    return NextResponse.json({ error: "That enquiry no longer exists." }, { status: 404 });
  }
  if (!enquiry.from_email) {
    /* §24 — say what is missing and what to do, never a bare refusal. */
    return NextResponse.json(
      { error: "This enquiry has no sender address, so there is nowhere to reply. Open the lead and add an email there." },
      { status: 422 },
    );
  }

  const sent = await sendEmail({
    to:      enquiry.from_email,
    subject: parsed.subject,
    text:    parsed.body,
    /* Routing context: if this tenant has connected their own Gmail, the reply leaves from
       their address rather than ours. Omitting it would silently send every reply through
       Resend — see lib/email/provider.ts. */
    route:   { tenantId: me.tenant_id },
    /* The label the screen reads back to decide whether this enquiry was answered. */
    kind:    "enquiry_reply",
  });

  if (sent.status === "failed") {
    return NextResponse.json(
      { error: sent.errorMessage ?? "The email could not be sent. Nothing was recorded, so you can try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    /* "stubbed" means no mail provider is configured and NOTHING actually left. Reported so
       the screen can say so instead of showing a tick for an email nobody received. */
    stub: sent.status === "stubbed",
    provider: sent.provider,
  });
}

/**
 * GET — what has already been sent in answer to this enquiry.
 *
 * Read out of email_log rather than a `replied_at` flag, for the reason in
 * lib/inbound/replied.ts: a flag the app writes can disagree with whether an email
 * actually left, and the log records what the provider reported.
 *
 * ─── MATCHED ON RECIPIENT + KIND, AND THAT IS AN OVER-MATCH ─────────────────
 * email_log has no enquiry id, so two enquiries from the SAME address inside the same
 * period both see each other's replies. That is the honest direction to be wrong in: it
 * can say "you already replied" once too often, which costs a rep three seconds of
 * reading, where the opposite silently permits the duplicate this exists to prevent.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ replies: [] });

  const admin = createAdminClient();
  const { data: enquiry } = await admin
    .from("inbound_emails")
    .select("id, from_email, created_at")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!enquiry?.from_email) return NextResponse.json({ replies: [] });

  const { data: rows } = await (admin as unknown as EmailLogReader)
    .from("email_log")
    .select("created_at, status, subject")
    .eq("tenant_id", me.tenant_id)
    .eq("recipient", enquiry.from_email)
    .eq("kind", "enquiry_reply")
    /* The window opens when the email arrived. Anything earlier is a different
       conversation — see lib/inbound/replied.ts. */
    .gte("created_at", enquiry.created_at)
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    replies: (rows ?? []).map((r) => ({
      sentAt:  r.created_at,
      status:  r.status,
      subject: r.subject,
    })),
  });
}

/**
 * email_log is not in the generated types yet (lib/email/log.ts says the same). Narrowed
 * to exactly the three columns read here rather than reached for with `any`, so a rename
 * in the table still shows up as a type error at this line.
 */
interface EmailLogReader {
  from(t: "email_log"): {
    select(cols: string): {
      eq(c: string, v: string): {
        eq(c: string, v: string): {
          eq(c: string, v: string): {
            gte(c: string, v: string): {
              order(c: string, o: { ascending: boolean }): {
                limit(n: number): Promise<{
                  data: { created_at: string; status: string; subject: string | null }[] | null;
                }>;
              };
            };
          };
        };
      };
    };
  };
}
