/**
 * POST /api/marketing/whatsapp/templates/sync
 *
 * Pulls the company's message templates from Meta (GET /{WABA_ID}/message_templates) and
 * brings whatsapp_templates in line: each template's approval status and Meta id are
 * updated; one not yet in the app is added with its body, and a guessed slot mapping that
 * the page flags for checking. A body already in the app is never overwritten — the
 * mapping of slots to lead fields was chosen by a person against that exact text.
 *
 * Needs WhatsApp connected with the business account id (tenant_secrets); 409 otherwise.
 * Authentication templates (OTP) are skipped — they are not for broadcasts.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resolveWhatsAppCreds } from "@/lib/whatsapp/client";
import { paramCount, type ParamField } from "@/lib/marketing/whatsapp-broadcast";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Record<string, string> = {
  APPROVED: "approved", REJECTED: "rejected", PENDING: "submitted", IN_APPEAL: "submitted",
  PAUSED: "paused", DISABLED: "paused", LIMIT_EXCEEDED: "paused",
};
const GUESS: ParamField[] = ["first_name", "sender", "company"];

interface MetaTemplate {
  id: string; name: string; language: string; status: string; category: string;
  components?: { type: string; text?: string }[];
}

export async function POST() {
  const userClient = createClient();
  const { data: auth } = await userClient.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { data: me } = await userClient.from("users").select("tenant_id").eq("id", auth.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "Aapka account kisi company se juda nahi hai." }, { status: 403 });

  const creds = await resolveWhatsAppCreds(me.tenant_id);
  if (!creds?.businessAccountId) {
    return NextResponse.json({ error: "WhatsApp connect nahi hai, ya Business Account ID nahi bhara — Settings mein jodo.", code: "not_configured" }, { status: 409 });
  }

  const found: MetaTemplate[] = [];
  let url: string | null =
    `https://graph.facebook.com/v18.0/${encodeURIComponent(creds.businessAccountId)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
  for (let page = 0; url && page < 10; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ error: `Meta ne mana kiya: ${j?.error?.message ?? res.status}` }, { status: 502 });
    }
    found.push(...((j.data ?? []) as MetaTemplate[]));
    url = j.paging?.next ?? null;
  }

  const db = createAdminClient() as unknown as { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data: existing } = await db.from("whatsapp_templates").select("id, name, language").eq("tenant_id", me.tenant_id);
  const have = new Map(((existing ?? []) as { id: string; name: string; language: string }[]).map((t) => [`${t.name}|${t.language}`, t.id]));

  let updated = 0, added = 0;
  for (const t of found) {
    if (t.category === "AUTHENTICATION") continue;
    const status = STATUS[t.status] ?? "submitted";
    const category = t.category === "UTILITY" ? "UTILITY" : "MARKETING";
    const id = have.get(`${t.name}|${t.language}`);
    if (id) {
      await db.from("whatsapp_templates").update({ status, meta_id: t.id, category, updated_at: new Date().toISOString() }).eq("id", id);
      updated++;
    } else {
      const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
      if (!body) continue;
      const n = paramCount(body);
      await db.from("whatsapp_templates").insert({
        tenant_id: me.tenant_id, name: t.name, language: t.language, category, body, status, meta_id: t.id,
        param_map: Array.from({ length: n }, (_, i) => GUESS[i] ?? "first_name"),
        notes: n > 0 ? "Meta se aaya — har {{n}} ka field check karo" : null,
        created_by: auth.user.id,
      });
      added++;
    }
  }
  return NextResponse.json({ found: found.length, updated, added });
}
