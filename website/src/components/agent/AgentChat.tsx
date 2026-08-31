"use client";
/**
 * "Talk to our live AI sales agent" — the launcher sits directly ABOVE the WhatsApp pill
 * (Pardeep: "company ke main home page par WhatsApp us ke upar lagao"), and the panel is
 * a small chat whose answers come from the app's public agent — live catalogue prices,
 * guarded server-side (production/src/lib/ai/public-sales-chat.ts holds the rules).
 *
 * The widget itself is deliberately thin: it renders text, it never computes a price, and
 * when the agent suggests a quote it renders a LINK to /quote with the selection prefilled
 * — the same handover the calculator uses, so every priced document keeps coming from the
 * one proven path.
 *
 * Failure shape: if the agent cannot answer, the visitor is told plainly and offered
 * WhatsApp — never a spinner that outlives its welcome, never an invented answer.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { WHATSAPP_URL } from "@/lib/config";

interface Msg {
  role: "user" | "assistant";
  text: string;
  suggestQuote?: { tier: "starter" | "standard" | "plus"; seats: number; term: "annual" | "monthly" } | null;
  /** Set when THIS reply filed the lead — renders the confirmation chip. */
  leadCreated?: { quoteId: string | null } | null;
}

/** The /quote page's edition names for the agent's tier ids. */
const TIER_EDITION: Record<string, string> = {
  starter: "GW Business Starter",
  standard: "GW Business Standard",
  plus: "GW Business Plus",
};

const GREETING: Msg = {
  role: "assistant",
  /* Pehla practical sawaal greeting me hi — discovery wahi se shuru hoti hai. */
  text: "Namaste! Main Anutech ka AI sales assistant hoon — daam hamare live catalogue se aate hain. Bataiye, kitne logo ke liye business email chahiye?",
};

export function AgentChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /* Ek chat, ek lead — server ko har request me batate hain ki lead ban chuki, taaki
     model dobara lead field bhare to bhi doosri row na bane. */
  const [leadCaptured, setLeadCaptured] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setFailed(false);
    const next: Msg[] = [...msgs, { role: "user", text }];
    setMsgs(next);
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /* The greeting is presentation, not conversation — the agent should not have to
           account for words the model never said. Only real turns travel. */
        body: JSON.stringify({
          messages: next.slice(1).slice(-16).map((m) => ({ role: m.role, text: m.text })),
          leadAlreadyCaptured: leadCaptured,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { reply?: string; suggestQuote?: Msg["suggestQuote"]; leadCreated?: { quoteId: string | null } | null };
      if (!data.reply) throw new Error("empty");
      if (data.leadCreated) setLeadCaptured(true);
      setMsgs((cur) => [...cur, { role: "assistant", text: data.reply!, suggestQuote: data.suggestQuote ?? null, leadCreated: data.leadCreated ?? null }]);
    } catch {
      setFailed(true);
      setMsgs((cur) => [
        ...cur,
        { role: "assistant", text: "Abhi jawab nahi de paya — WhatsApp par ek insaan ~11 minute me jawab deta hai, ya Get a quote page se turant priced estimate le lijiye." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Launcher — fixed, WhatsApp pill (bottom 22) ke THEEK UPAR. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Talk to our live AI sales agent"
        style={{
          position: "fixed", right: 22, bottom: 78, zIndex: 90,
          display: "inline-flex", alignItems: "center", gap: 9,
          background: "var(--primary)", color: "#fff", border: "none", borderRadius: 999,
          padding: "12px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer",
          boxShadow: "var(--shadow-panel)", fontFamily: "inherit",
        }}
      >
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "#7EF0B2", animation: "wPulse 1.6s infinite" }} />
        Talk to our live AI sales agent
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="AI sales agent chat"
          style={{
            position: "fixed", right: 22, bottom: 132, zIndex: 96,
            width: 360, maxWidth: "92vw", height: 460, maxHeight: "70vh",
            background: "#fff", border: "1px solid var(--border)", borderRadius: 12,
            boxShadow: "var(--shadow-menu)", display: "flex", flexDirection: "column",
            animation: "wDrop .16s ease", overflow: "hidden",
          }}
        >
          <div style={{ background: "var(--dark)", color: "#fff", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: "var(--bar-ok)" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>AI sales agent</div>
              <div className="mono-label" style={{ color: "#9AA5B1" }}>LIVE CATALOGUE PRICES</div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" style={{ background: "none", border: "none", color: "#9AA5B1", fontSize: 16, cursor: "pointer" }}>✕</button>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
                <div
                  style={{
                    padding: "9px 12px", borderRadius: 10, fontSize: 14, lineHeight: 1.45,
                    background: m.role === "user" ? "var(--primary)" : "var(--tint)",
                    color: m.role === "user" ? "#fff" : "var(--text)",
                    border: m.role === "user" ? "none" : "1px solid var(--border)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {m.text}
                </div>
                {m.leadCreated && (
                  <div
                    className="mono-label"
                    style={{ marginTop: 6, display: "inline-block", padding: "6px 10px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)" }}
                  >
                    {m.leadCreated.quoteId
                      ? `DETAILS MILE — QUOTATION ${m.leadCreated.quoteId} BAN GAYI`
                      : "DETAILS MILE — HUMARI TEAM SAMPARK KAREGI"}
                  </div>
                )}
                {m.suggestQuote && TIER_EDITION[m.suggestQuote.tier] && (
                  <Link
                    href={{
                      pathname: "/quote",
                      query: {
                        edition: TIER_EDITION[m.suggestQuote.tier],
                        seats: String(m.suggestQuote.seats),
                        term: m.suggestQuote.term,
                      },
                    }}
                    className="btn btn-primary btn-sm"
                    style={{ marginTop: 6, display: "inline-block" }}
                  >
                    Get this quote — {m.suggestQuote.seats} seats, {m.suggestQuote.term}
                  </Link>
                )}
              </div>
            ))}
            {busy && (
              <div style={{ alignSelf: "flex-start", padding: "9px 12px", borderRadius: 10, background: "var(--tint)", border: "1px solid var(--border)", fontSize: 14, color: "var(--text-muted)" }}>
                typing<span style={{ animation: "wPulse 1.1s infinite" }}>…</span>
              </div>
            )}
            {failed && (
              <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }}>
                WhatsApp us instead
              </a>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--border-light)" }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. 20 logo ke liye Workspace ka daam?"
              aria-label="Message the AI sales agent"
              style={{ flex: 1, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "10px 12px", fontSize: 14, fontFamily: "inherit", minWidth: 0 }}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
