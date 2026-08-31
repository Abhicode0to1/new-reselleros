/**
 * POST /api/public/agent/chat — the website's live AI sales agent.
 *
 * Anonymous, so everything about it is bounded: message count and length are capped
 * (lib/ai/public-sales-chat.ts), the model receives a hand-picked page of PUBLIC facts
 * rather than any database access, and every reply passes the money guard before a
 * visitor sees it. The full design argument lives in public-sales-chat.ts.
 *
 * Gemini goes through the ONE gateway (lib/ai/gemini.ts — timeout, circuit breaker,
 * retry, stated failure reasons). When the gateway cannot answer — no key, breaker open,
 * quota — the visitor gets the honest fallback: quote page + WhatsApp, never an error
 * page and never a made-up answer.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { publicWorkspaceCatalog } from "@/lib/catalog/public-workspace";
import {
  sanitizeMessages,
  buildFacts,
  systemPrompt,
  guardReply,
  fallbackReply,
  leadDetailsAppearInTranscript,
  type PublicChatReply,
} from "@/lib/ai/public-sales-chat";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }

  const messages = sanitizeMessages((body as Record<string, unknown>)?.messages);
  if (!messages) {
    return NextResponse.json({ error: "messages must be a non-empty array ending with the visitor's turn" }, { status: 400 });
  }

  const admin = createAdminClient();

  /* Live facts — the same shape (and the same wholesale-stripping) as the public
     catalogue endpoint. A failure here degrades to an empty price list; the prompt tells
     the model to offer the quote page in that case rather than remember old prices. */
  const { data: rows } = await admin
    .from("items")
    .select("name, msrp, prices")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("vendor", "google")
    .eq("kind", "main")
    .eq("is_active", true)
    .ilike("name", "Google Workspace%")
    .order("msrp", { ascending: true });

  const { data: tenant } = await admin
    .from("tenants")
    .select("name, phone")
    .eq("id", BUY_PAGE_TENANT_ID)
    .maybeSingle();

  const facts = buildFacts(publicWorkspaceCatalog(rows ?? []), {
    name: tenant?.name?.trim() || "Anutech Digital Pvt Ltd",
    phone: tenant?.phone?.trim() || null,
    supportHours: "Mon–Sat, 10:00–19:00 IST",
  });

  const gemini = await resolveGeminiConfig(admin, BUY_PAGE_TENANT_ID);
  if (!gemini.apiKey) {
    /* No key configured is a stated state, not an error page — the visitor still gets a
       useful answer. */
    return NextResponse.json(fallbackReply() satisfies PublicChatReply);
  }

  /* The transcript goes in the user part, clearly fenced, so a visitor writing "system:"
     cannot promote themselves — the real system prompt travels in systemInstruction. */
  const transcript = messages
    .map((m) => `${m.role === "user" ? "VISITOR" : "ASSISTANT"}: ${m.text}`)
    .join("\n");

  const raw = await geminiJson<PublicChatReply>({
    apiKey: gemini.apiKey,
    model: gemini.model,
    system: systemPrompt(facts.factsText),
    user: `Conversation so far:\n${transcript}\n\nAnswer the visitor's last message.`,
    temperature: 0.4,
    timeoutMs: 20_000,
    label: "public/agent-chat",
  });

  if (!raw) return NextResponse.json(fallbackReply() satisfies PublicChatReply);

  const guarded = guardReply(raw, facts.allowedFigures);

  /* ── THE LEAD — the whole point of the chat, filed through the PROVEN path ──
     Three conditions before anything is written:

       1. guardReply validated the fields (shape, email regex, 10-digit phone).
       2. The details literally appear in VISITOR turns — the model only ever sees the
          transcript, so a true detail must be quoted from it. A hallucinated contact is
          dropped silently and the visitor simply gets asked again later.
       3. The widget has not already been credited (leadAlreadyCaptured) — one chat, one
          lead. The app's own Duplicate? marker is the backstop behind that.

     Then the enquiry goes to this deployment's OWN public enquiry endpoints — the same
     machinery, gates, auto-quote and mails as the website form. Self-addressed via the
     request's own origin rather than an env URL, because an env-configured self-URL in
     this repo has already pointed at a dead service once. */
  const alreadyCaptured = (body as Record<string, unknown>)?.leadAlreadyCaptured === true;
  let leadCreated: { quoteId: string | null } | null = null;

  if (guarded.lead && !alreadyCaptured && leadDetailsAppearInTranscript(guarded.lead, messages)) {
    const L = guarded.lead;
    const origin = request.nextUrl.origin;
    const summary = messages
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join(" | ")
      .slice(0, 1_500);
    try {
      if (L.tier && L.seats) {
        const res = await fetch(new URL("/api/public/enquiry/workspace", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: L.fullName,
            companyName: L.company || L.fullName,
            email: L.email,
            phone: L.phone,
            seats: L.seats,
            tierId: L.tier,
            billing: L.term === "monthly" ? "monthly" : "annual",
            message: `Via the website AI sales chat. Conversation: ${summary}`,
          }),
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as { draftQuoteId?: string | null };
          leadCreated = { quoteId: data.draftQuoteId ?? null };
        }
      } else {
        const res = await fetch(new URL("/api/public/enquiry/general", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: L.fullName,
            companyName: L.company || L.fullName,
            email: L.email,
            phone: L.phone,
            product: "google-workspace",
            ...(L.seats ? { seats: L.seats } : {}),
            message: `Via the website AI sales chat. Conversation: ${summary}`,
          }),
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        if (res.ok) leadCreated = { quoteId: null };
      }
    } catch (err) {
      /* The chat reply still goes out — a failed lead write must not eat the answer. The
         operator side loses nothing permanent: the visitor was told a person follows up,
         and the transcript asks again on a later turn because the widget was not credited. */
      console.error("[public/agent-chat] lead filing failed:", err);
    }
  }

  return NextResponse.json({ ...guarded, leadCreated } satisfies PublicChatReply & { leadCreated: { quoteId: string | null } | null });
}
