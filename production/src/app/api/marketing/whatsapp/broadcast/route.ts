/**
 * POST /api/marketing/whatsapp/broadcast
 *   { templateId, audience: { stages?: string[]; sources?: string[] }, dryRun?: boolean }
 *
 * Sends one approved WhatsApp template to every lead in the audience that has a mobile
 * number and has not opted out. Each send goes through sendWhatsApp, which logs it in
 * whatsapp_messages; this route records the batch in whatsapp_broadcasts.
 *
 * dryRun returns the count that WOULD be sent and a sample, and sends nothing — the page
 * shows it before the confirm.
 *
 * Refuses, sending nothing, when WhatsApp is not connected for the company (409), the
 * template is not approved, or the audience is empty. Capped at MAX_PER_RUN so one click
 * cannot run past the request time or burn the number's quality rating.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp, resolveWhatsAppCreds } from "@/lib/whatsapp/client";
import {
  slotValues, bodyComponents, renderBody, normalizeWaPhone, firstName, templateProblem,
} from "@/lib/marketing/whatsapp-broadcast";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PER_RUN = 250;

const schema = z.object({
  templateId: z.string().uuid(),
  audience: z.object({ stages: z.array(z.string()).optional(), sources: z.array(z.string()).optional() }).default({}),
  dryRun: z.boolean().optional(),
});

type Stage = "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";

export async function POST(req: NextRequest) {
  const userClient = createClient();
  const { data: auth } = await userClient.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { data: me } = await userClient.from("users").select("tenant_id").eq("id", auth.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "Aapka account kisi company se juda nahi hai." }, { status: 403 });
  const tenantId = me.tenant_id;

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Template aur audience chuno." }, { status: 400 });
  const { templateId, audience, dryRun } = parsed.data;

  /* Service role from here, every query pinned to this tenant. The new tables are newer
     than the generated types, hence the untyped handle. */
  const admin = createAdminClient();
  const db = admin as unknown as { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any

  const { data: tpl } = await db.from("whatsapp_templates")
    .select("id, name, language, body, param_map, status").eq("id", templateId).eq("tenant_id", tenantId).maybeSingle();
  if (!tpl) return NextResponse.json({ error: "Template nahi mila." }, { status: 404 });
  if (tpl.status !== "approved") {
    return NextResponse.json({ error: "Sirf Meta se approved template bheja ja sakta hai." }, { status: 400 });
  }
  const paramMap = (Array.isArray(tpl.param_map) ? tpl.param_map : []) as string[];
  const problem = templateProblem(tpl.body, paramMap);
  if (problem) return NextResponse.json({ error: `Template theek karo: ${problem}` }, { status: 400 });

  // ── Audience ──────────────────────────────────────────────────────────────
  let q = admin.from("leads").select("id, contact_name, company, contact_phone").eq("tenant_id", tenantId)
    .not("contact_phone", "is", null).eq("is_junk", false);
  if (audience.stages?.length) q = q.in("stage", audience.stages as Stage[]);
  if (audience.sources?.length) q = q.in("source", audience.sources);
  const { data: leads, error: lErr } = await q;
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 });

  const { data: outs } = await db.from("whatsapp_opt_outs").select("phone").eq("tenant_id", tenantId);
  const optedOut = new Set(((outs ?? []) as { phone: string }[]).map((o) => o.phone));

  const seen = new Set<string>();
  let noPhone = 0, skippedOptOut = 0;
  const recipients: { leadId: string; phone: string; first: string; company: string | null }[] = [];
  for (const l of (leads ?? []) as { id: string; contact_name: string | null; company: string | null; contact_phone: string | null }[]) {
    const phone = normalizeWaPhone(l.contact_phone);
    if (!phone) { noPhone++; continue; }
    if (optedOut.has(phone)) { skippedOptOut++; continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    recipients.push({ leadId: l.id, phone, first: firstName(l.contact_name), company: l.company });
  }

  const { data: tenant } = await admin.from("tenants").select("name").eq("id", tenantId).single();
  const sender = tenant?.name ?? "";
  const capped = recipients.slice(0, MAX_PER_RUN);

  if (dryRun) {
    const sample = capped[0];
    return NextResponse.json({
      recipients: capped.length, overCap: Math.max(0, recipients.length - MAX_PER_RUN),
      skippedOptOut, noPhone,
      sample: sample ? renderBody(tpl.body, slotValues(paramMap, { first_name: sample.first, company: sample.company, sender })) : null,
      connected: (await resolveWhatsAppCreds(tenantId)) !== null,
    });
  }

  if (capped.length === 0) return NextResponse.json({ error: "Is audience mein WhatsApp number wala koi lead nahi." }, { status: 400 });
  if (!(await resolveWhatsAppCreds(tenantId))) {
    return NextResponse.json({ error: "WhatsApp abhi connect nahi hai — Settings mein WhatsApp Business API jodo.", code: "not_configured" }, { status: 409 });
  }

  const { data: bc, error: bErr } = await db.from("whatsapp_broadcasts").insert({
    tenant_id: tenantId, template_id: tpl.id, template_name: tpl.name, audience,
    recipients_count: capped.length, skipped_count: skippedOptOut, created_by: auth.user.id,
  }).select("id").single();
  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 });

  let sent = 0, failed = 0;
  for (const r of capped) {
    try {
      const values = slotValues(paramMap, { first_name: r.first, company: r.company, sender });
      const res = await sendWhatsApp({
        tenantId, to: r.phone,
        message: { kind: "template", name: tpl.name, language: tpl.language, components: bodyComponents(values) },
        related: { leadId: r.leadId },
      });
      if (res.status === "failed") failed++; else sent++;
    } catch {
      failed++;
    }
  }

  await db.from("whatsapp_broadcasts").update({
    sent_count: sent, failed_count: failed, status: sent === 0 ? "failed" : "sent",
  }).eq("id", bc.id);

  return NextResponse.json({ broadcastId: bc.id, recipients: capped.length, sent, failed, skippedOptOut, overCap: Math.max(0, recipients.length - MAX_PER_RUN) });
}
