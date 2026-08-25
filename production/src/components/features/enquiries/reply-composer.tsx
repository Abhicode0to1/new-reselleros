/**
 * The inline reply box under an enquiry.
 *
 * ─── WHY IT SITS UNDER THE CONVERSATION, NOT IN A DIALOG ────────────────────
 * The reply is written while reading the email. A modal covers the thing being answered,
 * so the seat count and the product name have to be held in the operator's head — which is
 * exactly where the wrong number comes from. Everything the reply refers to stays on screen
 * while it is typed.
 *
 * ─── A PILL FILLS THE BOX; IT DOES NOT SEND ─────────────────────────────────
 * One tap that both writes and sends an email in the reseller's name is how a wrong name or
 * a half-finished sentence reaches a customer, and an email cannot be recalled. The pill
 * writes, the human reads, the human sends. See lib/inbound/reply-pills.ts.
 *
 * ─── AND A PILL NEVER SILENTLY OVERWRITES TYPING ────────────────────────────
 * If there is text in the box already, tapping a pill asks before replacing it. Losing a
 * half-written reply to a mis-tap is small, frequent, and completely avoidable.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { pillsFor, pillDraft, replySubject, type PillContext } from "@/lib/inbound/reply-pills";
import { repliedState, repliedNote, repliedIsProblem, type ReplyRef } from "@/lib/inbound/replied";
import { useEnquiryReplies, useSendEnquiryReply } from "@/lib/queries/inbound-emails";

export interface ReplyComposerProps {
  enquiryId: string;
  /** Where the reply goes. Shown, never editable — the route ignores any address sent. */
  toEmail: string | null;
  originalSubject: string | null;
  /** When the enquiry arrived — the window "already replied" is judged against. */
  receivedAt: string;
  /** Facts the extractor read, so a pill's draft is worth the tap. */
  context: PillContext;
  formatWhen: (iso: string) => string;
  /**
   * The lead this thread belongs to, when there is one.
   *
   * OPTIONAL: /enquiries can show a reply box for an email that has not become a lead
   * yet, and there is no conversation to read in that case. Absent simply hides the AI
   * button — a button that always fails is worse than no button.
   */
  leadId?: string | null;
}

export function ReplyComposer({
  enquiryId, toEmail, originalSubject, receivedAt, context, formatWhen, leadId = null,
}: ReplyComposerProps) {
  const [subject, setSubject] = React.useState(() => replySubject(originalSubject));
  const [body, setBody]       = React.useState("");

  /* A new enquiry gets a fresh box. Without this the previous customer's half-typed reply
     would still be sitting there under someone else's email. */
  React.useEffect(() => {
    setSubject(replySubject(originalSubject));
    setBody("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enquiryId]);

  const { data: replies } = useEnquiryReplies(enquiryId);
  const send = useSendEnquiryReply();

  const state = React.useMemo(
    () => repliedState(receivedAt, (replies ?? []) as ReplyRef[]),
    [receivedAt, replies],
  );
  const note = repliedNote(state, formatWhen);

  const pills = React.useMemo(() => pillsFor(context), [context]);

  function applyPill(id: (typeof pills)[number]["id"]) {
    const draft = pillDraft(id, context);
    if (body.trim() && body.trim() !== draft.trim()) {
      /* Asked, not assumed. Silently discarding typed text is the small betrayal that
         makes people stop trusting the buttons. */
      if (!window.confirm("Replace what you have written with this reply?")) return;
    }
    setBody(draft);
  }

  /* ── Draft with AI ────────────────────────────────────────────────────────
     Asked for as "AI human ki tarah reply de". It sits BESIDE the quick replies rather
     than replacing them: the pills are deterministic and instant, and on an outage or a
     money-guard rejection they are what the operator falls back to.

     It fills the box. Sending stays the separate, deliberate act it already is — an email
     cannot be recalled, and the reason this reply is worth drafting is that the customer
     has corrected us twice. */
  const [aiBusy, setAiBusy] = React.useState(false);
  /**
   * The draft the AI produced, kept EXACTLY as it came back.
   *
   * ─── WHY THE COMPONENT REMEMBERS IT AND THE SERVER DOES NOT ─────────────────
   * The comparison this feeds is "what did the person change", and only this component knows
   * the answer: it holds the text that was put in the box and the text that leaves it. The
   * server could look up the newest draft on the lead, and that is a different question — a
   * rep who drafted, went for lunch and then typed something else would be recorded as having
   * rewritten a draft they never read.
   *
   * Cleared whenever the box is emptied after a successful send, so the NEXT reply — typed
   * from scratch — is not measured against a draft from the last one.
   */
  const [aiDraft, setAiDraft] = React.useState<{ subject: string; body: string } | null>(null);

  async function draftWithAi() {
    if (!leadId) return;
    if (body.trim() && !window.confirm("Replace what you have written with an AI draft?")) return;
    setAiBusy(true);
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/draft-reply`, { method: "POST" });
      const json = await res.json() as { subject?: string; message?: string; error?: string };
      if (!res.ok || !json.message) {
        /* The route's own message names the reason and the fallback — "use a quick reply",
           "send the revised quotation first". Replacing it with a generic failure would
           throw away the only part that says what to do (§24). */
        toast.error(json.error ?? "Could not draft a reply.");
        return;
      }
      setBody(json.message);
      if (json.subject?.trim()) setSubject(json.subject.trim());
      setAiDraft({ subject: json.subject?.trim() ?? "", body: json.message });
    } catch {
      toast.error("Could not reach the drafting service.", {
        description: "Use one of the quick replies, or write it by hand.",
      });
    } finally {
      setAiBusy(false);
    }
  }

  const canSend = Boolean(toEmail) && subject.trim().length > 0 && body.trim().length > 0;

  function onSend() {
    if (!toEmail) {
      /* §24 — what happened, why, what to do next. */
      toast.error("There is no address to reply to.", {
        description: "This email arrived without a sender address. Open the lead and add one, then write from there.",
      });
      return;
    }
    send.mutate(
      {
        id: enquiryId,
        subject: subject.trim(),
        body: body.trim(),
        /* Only when this send actually started from a draft. Sending it unconditionally would
           record rows for replies the agent never touched, and every "how often was the draft
           good enough" number would be quietly wrong. */
        ...(aiDraft ? { ai_draft_subject: aiDraft.subject, ai_draft_body: aiDraft.body } : {}),
      },
      {
        /* Cleared only when mail actually LEFT. A box that empties on click would, on a
           failed send, look exactly like a successful one — and on a stubbed send the
           toast says "send it again", which is impossible if the text is gone. */
        onSuccess: (result) => { if (!result.stub) { setBody(""); setAiDraft(null); } },
      },
    );
  }

  return (
    <section className="mt-4 rounded-lg border border-hairline bg-paper-2/30 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Reply</h3>
        <span className="truncate text-2xs text-ink-3">
          {toEmail ? <>To <span className="font-mono text-ink-2">{toEmail}</span></> : "No sender address on this email"}
        </span>
      </div>

      {/* Already answered — stated before the box, not after the send. */}
      {note && (
        <p className={cn(
          "mb-2.5 rounded-md border px-2.5 py-1.5 text-[12px] leading-snug",
          repliedIsProblem(state)
            ? "border-rose bg-rose-soft text-rose-ink"
            : "border-hairline bg-paper text-ink-2",
        )}>
          {note}
        </p>
      )}

      {/* ── The pills ──────────────────────────────────────────────────────
          Each one carries its reason as a title. They FILL the box below; the
          Send button is still a separate, deliberate act. */}
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            onClick={() => applyPill(p.id)}
            className="rounded-full border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-amber hover:text-amber-ink"
          >
            {p.label}
          </button>
        ))}
        {/* Only where there is a lead to read a thread from — on a bare enquiry with no
            lead there is no conversation to answer, and a button that always fails is
            worse than no button. */}
        {leadId && (
          <button
            type="button"
            title="Reads this conversation and writes the reply their last message deserves. It fills the box — you still press Send."
            onClick={() => void draftWithAi()}
            disabled={aiBusy}
            className="rounded-full border border-amber/50 bg-amber-soft/30 px-2.5 py-1 text-[12px] text-amber-ink transition-colors hover:border-amber disabled:opacity-60"
          >
            {aiBusy ? "Drafting…" : "✨ Draft with AI"}
          </button>
        )}
        {body.trim() && (
          <button
            type="button"
            onClick={() => setBody("")}
            className="rounded-full px-2.5 py-1 text-[12px] text-ink-3 hover:text-rose"
          >
            Clear
          </button>
        )}
      </div>

      <div className="space-y-2">
        <div>
          <Label htmlFor="reply-subject" className="text-2xs text-ink-3">Subject</Label>
          <Input
            id="reply-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="mt-1 h-9 text-[13px]"
          />
        </div>

        <div>
          <Label htmlFor="reply-body" className="text-2xs text-ink-3">Message</Label>
          <Textarea
            id="reply-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            placeholder="Write your reply, or tap one of the replies above and edit it."
            className="mt-1 text-[13px] leading-relaxed"
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xs leading-snug text-ink-3">
          {/* The one thing a rep must not assume this box does. Prices belong to the quote
              builder, where the rate, discount and GST are computed together. */}
          Prices are never sent from here — use <span className="font-medium text-ink-2">Send quote</span> for anything with a figure in it.
        </p>
        <Button size="sm" onClick={onSend} loading={send.isPending} disabled={!canSend}>
          Send reply
        </Button>
      </div>
    </section>
  );
}
