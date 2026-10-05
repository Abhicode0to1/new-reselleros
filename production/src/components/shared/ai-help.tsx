"use client";

/**
 * AI Help — a chat icon on every app page (R-158, 5 Oct 2026). For people testing the app:
 * ask what a screen does or why something looks wrong; when the chat finds a bug, the AI
 * drafts a proper report, the person reads it and presses "File this report", and it lands
 * in Report Bug / Admin → Feedback under THEIR name, marked "🤖 AI-drafted after chat".
 *
 * Nothing is filed without that press: the draft is shown in full first (lib/ai/app-help.ts).
 * The chat lives only in this tab (state, not storage) — a closed panel keeps it, a reload
 * starts fresh.
 */
import * as React from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSubmitFeedback } from "@/lib/queries/feedback";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { bugReportText, AI_FILED_TAG, type BugDraft, type HelpMessage } from "@/lib/ai/app-help";

interface ChatItem extends HelpMessage { draft?: BugDraft | null; filedId?: string; page?: string | null }

const SEV_LABEL: Record<BugDraft["severity"], string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const TYPE_LABEL: Record<BugDraft["type"], string> = { bug: "Bug", feature: "Feature", ui_improvement: "UI improvement" };

export function AiHelp() {
  const pathname = usePathname();
  const { data: currentUser } = useCurrentUser();
  const submit = useSubmitFeedback();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<ChatItem[]>([]);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [filing, setFiling] = React.useState<number | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [items, busy, open]);
  React.useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatItem[] = [...items, { role: "user", text: q, page: pathname }];
    setItems(next); setText(""); setBusy(true);
    try {
      const res = await fetch("/api/ai/help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, text: t }) => ({ role, text: t })), pagePath: pathname }),
      });
      const j = (await res.json().catch(() => ({}))) as { reply?: string; bugDraft?: BugDraft | null; error?: string };
      const reply = j.reply || j.error || "Jawab nahi aaya — dobara try karein.";
      setItems((s) => [...s, { role: "assistant", text: reply, draft: j.bugDraft ?? null, page: pathname }]);
    } catch {
      setItems((s) => [...s, { role: "assistant", text: "Connection nahi bana — dobara try karein. Bug ho to 'Report Bug' button bhi chalta hai." }]);
    } finally {
      setBusy(false);
    }
  }

  async function file(idx: number) {
    const it = items[idx];
    if (!it?.draft || it.filedId) return;
    setFiling(idx);
    try {
      const result = await submit.mutateAsync({
        tenantId: currentUser?.tenantId ?? "",
        reportedType: it.draft.type,
        reportedSeverity: it.draft.severity,
        text: bugReportText(it.draft, { pagePath: it.page ?? pathname, reporterName: currentUser?.fullName ?? null }),
        pagePath: it.page ?? pathname,
        reporterId: currentUser?.userId ?? null,
        reporterName: currentUser?.fullName ?? null,
        reporterEmail: currentUser?.authEmail ?? null,
        screenshots: [],
        filedVia: "ai-chat",
        aiChatSummary: it.draft.chatSummary || null,
      });
      setItems((s) => s.map((x, i) => (i === idx ? { ...x, filedId: result.id } : x)));
      toast.success("Report file ho gayi — aapke naam se", { description: `${AI_FILED_TAG}. Admin → Feedback mein dikhegi.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Report file nahi hui — dobara try karein.");
    } finally {
      setFiling(null);
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="AI Help — app ke baare mein poochho ya bug batao"
          title="AI Help"
          className="fixed z-50 right-4 bottom-20 md:bottom-5 h-12 pl-3.5 pr-4 rounded-full bg-ink text-paper shadow-lg flex items-center gap-2 text-sm font-semibold hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
        >
          <Icon name="sparkles" size={18} />
          <span>AI Help</span>
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="AI Help"
          className="fixed z-50 right-2 left-2 bottom-20 md:left-auto md:right-5 md:bottom-5 md:w-[400px] h-[min(560px,calc(100vh-7rem))] flex flex-col rounded-2xl border border-hairline bg-paper shadow-2xl overflow-hidden"
        >
          <header className="flex items-center gap-2 px-4 py-3 border-b border-hairline bg-paper-2/60">
            <Icon name="sparkles" size={16} className="text-amber-ink" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-ink">AI Help</div>
              <div className="text-2xs text-ink-3 truncate">Is page par: {pathname}</div>
            </div>
            {items.length > 0 && (
              <button type="button" className="text-2xs text-ink-3 hover:text-ink" onClick={() => setItems([])}>New chat</button>
            )}
            <button type="button" aria-label="Close" className="p-1 text-ink-3 hover:text-ink" onClick={() => setOpen(false)}>
              <Icon name="x" size={16} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {items.length === 0 && (
              <div className="text-sm text-ink-2 space-y-2 p-1">
                <p>Testing karte koi confusion ho to yahan poochhiye — ye screen kis kaam ki hai, kahan click karna hai, number sahi kyun nahi dikh raha.</p>
                <p>Bug mila to bataiye kya kiya aur kya hua. Main saaf report bana dunga; aap dekh kar <b>File</b> karenge, aur report aapke naam se jaayegi.</p>
              </div>
            )}
            {items.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[88%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-ink text-paper" : "bg-paper-2 text-ink"}`}>
                  {m.text}
                  {m.draft && (
                    <div className="mt-2 rounded-lg border border-hairline bg-paper p-2.5 text-ink space-y-1.5">
                      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Bug report — draft</div>
                      <div className="font-semibold">{m.draft.title}</div>
                      <div className="text-2xs text-ink-3">{TYPE_LABEL[m.draft.type]} · {SEV_LABEL[m.draft.severity]} · {m.page ?? pathname}</div>
                      <div className="text-xs"><b>Kya hua:</b> {m.draft.actual}</div>
                      {m.draft.expected && <div className="text-xs"><b>Kya hona chahiye:</b> {m.draft.expected}</div>}
                      {m.draft.steps.length > 0 && (
                        <ol className="text-xs list-decimal pl-4 space-y-0.5">{m.draft.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
                      )}
                      <div className="text-2xs text-ink-3">{AI_FILED_TAG} · aapke naam se: {currentUser?.fullName ?? "—"}</div>
                      {m.filedId ? (
                        <div className="text-xs font-semibold text-emerald">✓ File ho gayi — Admin → Feedback</div>
                      ) : (
                        <Button size="sm" variant="primary" loading={filing === i} disabled={filing !== null} onClick={() => file(i)}>File this report</Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="text-xs text-ink-3 px-1">AI soch raha hai…</div>}
            <div ref={endRef} />
          </div>

          <form onSubmit={send} className="border-t border-hairline p-2 flex gap-2 items-end">
            <label htmlFor="ai-help-input" className="sr-only">Aapka sawaal</label>
            <textarea
              id="ai-help-input"
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2}
              maxLength={1500}
              placeholder="Jaise: Invoice par GST galat kyun aa raha hai?"
              className="flex-1 resize-none rounded-lg border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
            />
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!text.trim()}>Send</Button>
          </form>
        </section>
      )}
    </>
  );
}
