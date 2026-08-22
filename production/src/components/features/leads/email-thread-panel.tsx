"use client";

/**
 * The email exchange on one lead, read top to bottom like a mail client.
 *
 * Reported by Pardeep on 22 Aug 2026: *"ab jo lead ke email id se email receive hongi wo
 * kahan dikhengi"* — he could not tell where a reply from the lead's address would appear.
 * It was appearing, interleaved with calls, quotes and tasks in one timeline, which reads
 * as a log and not as a conversation.
 *
 * Nothing new is stored. `inbound_emails` already holds both directions —
 * `lib/inbound/sent.ts` explains why a reply lives in the same table as the mail it
 * answers. `lib/leads/email-thread.ts` does the assembly and owns the ordering rules.
 */

import * as React from "react";
import { cn, formatDate } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import type { ThreadMessage, ThreadSummary } from "@/lib/leads/email-thread";

function fmtTime(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function EmailThreadPanel({
  thread,
  summary,
  leadEmail,
}: {
  thread: readonly ThreadMessage[];
  summary: ThreadSummary;
  leadEmail: string | null | undefined;
}) {
  if (thread.length === 0) {
    /* §24 — what, why, and what to do next. A blank panel here would read as "the feature
       is broken", which is exactly the confusion this tab was built to end. */
    return (
      <div className="rounded-md bg-paper-2 p-3 text-xs leading-relaxed text-ink-3">
        <b className="text-ink-2">No email either way yet.</b>
        {leadEmail ? (
          <> Mail sent to <span className="font-mono text-ink-2">{leadEmail}</span> and anything
          they send back will both appear here, oldest first.</>
        ) : (
          <> This lead has no email address on it, so there is nothing to send to or receive
          from. Add one with Edit.</>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-3">
          Email conversation
        </span>
        <span className="font-mono text-[11px] text-ink-3">
          {summary.inbound} in · {summary.outbound} out
        </span>
      </div>

      <ul className="space-y-2">
        {thread.map((m) => {
          const out = m.direction === "outbound";
          return (
            <li
              key={m.id}
              className={cn(
                "rounded-md border p-2.5",
                /* Ours indented and tinted, theirs flush left — the shape a mail thread is
                   read in, so direction is legible before any label is read. */
                out
                  ? "ml-5 border-amber/30 bg-amber-soft/30"
                  : "mr-5 border-hairline bg-paper-2",
              )}
            >
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-2">
                  <Icon name={out ? "send" : "mail"} size={11} className={out ? "text-amber-ink" : "text-ink-3"} />
                  {out ? "You" : (m.counterparty ?? "Them")}
                  {out && m.counterparty && (
                    <span className="font-normal text-ink-3">→ {m.counterparty}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-ink-3">
                  {formatDate(m.at ?? "")} {fmtTime(m.at)}
                </span>
              </div>

              {m.subject && (
                <div className="mb-1 truncate text-xs font-medium text-ink">{m.subject}</div>
              )}

              {m.body ? (
                /* whitespace-pre-wrap because a quoted reply's line breaks carry meaning —
                   collapsing them turns a readable message into a paragraph soup. */
                <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2">
                  {m.body}
                </div>
              ) : (
                /* Says which case this is rather than showing an empty bubble. An outbound
                   line with no body is a send that went through Gmail, where the text was
                   never kept — the drawer says so elsewhere and this must not contradict it. */
                <div className="text-[11px] italic text-ink-3">
                  {m.htmlOnly
                    /* Not rendered on purpose. body_html is whatever a stranger emailed in,
                       and putting it on screen means running their markup in this session. */
                    ? "This message came as formatted HTML only. Open it in your mail client to read it — it is not shown here because it is not plain text."
                    : out
                      /* Reachable only for a row filed without its text. The current send
                         path always stores the body, so this covers older or partial rows
                         rather than the Gmail hand-off it originally described. */
                      ? "This message was sent, but its text was not stored."
                      : "This message arrived with no readable body."}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {summary.awaitingFirstInbound && (
        /* The state that confused the reporter, named. We have written; they have not. */
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          They have not written back yet — everything above went out from your side. Their
          reply will appear here, and the reply box below becomes usable once it does.
        </p>
      )}
    </div>
  );
}
