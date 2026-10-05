/**
 * POST /api/ai/help — the in-app AI Help chat (R-158, 5 Oct 2026).
 *
 * Signed-in staff only. Takes the chat so far and the page the person is on; returns a
 * reply and, when the chat has found a bug, a draft report. It files NOTHING — the person
 * reads the draft and files it from the panel (lib/ai/app-help.ts explains why).
 *
 * Gemini through geminiJson (timeout + circuit breaker, null on every failure). With no
 * key or a failed call it says so plainly and points at the Report Bug button — the chat is
 * a help, never the only way to report.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { rateLimit } from "@/lib/security/rate-limit";
import { helpSystemPrompt, helpUserTurn, parseHelpAnswer, HELP_MAX_CHARS, HELP_MAX_MESSAGES } from "@/lib/ai/app-help";

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(HELP_MAX_CHARS * 2) })).min(1).max(HELP_MAX_MESSAGES * 2),
  pagePath: z.string().max(300).nullable().optional(),
});

const UNAVAILABLE = "AI Help abhi jawab nahi de pa raha. Bug ho to upar 'Report Bug' button (Ctrl+Shift+B) se seedha bhej dijiye.";

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  if (!rateLimit(`ai-help:${user.id}`, { limit: 30, windowMs: 10 * 60_000 }).ok) {
    return NextResponse.json({ error: "Thoda ruk kar poochhiye — 10 minute mein 30 sawaal ki seema hai." }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Message samajh nahi aaya — dobara likhiye." }, { status: 400 });
  const { messages, pagePath } = parsed.data;
  if (messages[messages.length - 1].role !== "user") return NextResponse.json({ error: "Last message must be yours." }, { status: 400 });

  // RLS scopes these reads to the caller's own row and tenant.
  const { data: me } = await supabase.from("users").select("tenant_id, full_name, role").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) return NextResponse.json({ reply: UNAVAILABLE, bugDraft: null, ai: false });

  let failure = "";
  const raw = await geminiJson<unknown>({
    apiKey: gemini.apiKey,
    model: gemini.model,
    system: helpSystemPrompt({ pagePath: pagePath ?? null, userName: me?.full_name ?? null, role: me?.role ?? null }),
    user: helpUserTurn(messages),
    temperature: 0.3,
    timeoutMs: 25_000,
    label: "ai/help",
    onFailure: (r) => { failure = r; },
  });
  const answer = parseHelpAnswer(raw);
  if (!answer) {
    if (failure) console.error("[ai/help] no answer:", failure);
    return NextResponse.json({ reply: UNAVAILABLE, bugDraft: null, ai: false });
  }
  return NextResponse.json({ ...answer, ai: true });
}
