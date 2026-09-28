"use client";
/** The drawer's Email tab — the two-sided thread and the reply box under it (S35, moved verbatim). */
import * as React from "react";
import { EmailThreadPanel } from "@/components/features/leads/email-thread-panel";
import { ReplyComposer } from "@/components/features/enquiries/reply-composer";
import { factsSuperseded, type buildEmailThread, type summariseThread } from "@/lib/leads/email-thread";
import { formatDate } from "@/lib/utils";
import type { InboundEmailRow, Lead } from "@/lib/supabase/database.types";
import type { useCurrentUser } from "@/lib/hooks/useCurrentUser";

export interface LeadEmailTabProps {
  lead: Lead;
  emailThread: ReturnType<typeof buildEmailThread>;
  threadSummary: ReturnType<typeof summariseThread>;
  loggedEmailSends: number;
  replyAnchor: InboundEmailRow | null;
  currentUser: ReturnType<typeof useCurrentUser>["data"];
}

export function LeadEmailTab({ lead, emailThread, threadSummary, loggedEmailSends, replyAnchor, currentUser }: LeadEmailTabProps) {
  return (
          <div>
            <EmailThreadPanel
              thread={emailThread}
              summary={threadSummary}
              leadEmail={lead.contact_email}
              loggedSendsWithoutText={loggedEmailSends}
            />
          {/* ── Reply to this lead, from here ──────────────────────────────────
              Under the thread, which is where a reply belongs — it used to render under
              both views of the old merged tab, and the half of that which was right is
              this half.
              ───────────────────────────────────────────────────────────────────
              Both halves of the conversation already existed and lived on different
              screens. Inbound mail was readable on the lead (the timeline above); replying
              was only possible on /enquiries. The lead's Email button USED TO open Gmail
              and record a one-line note — "Emailed x@y · subject" — so what was actually
              written was never kept anywhere. Since 22 Aug 2026 it opens
              LeadEmailComposer and posts to /api/leads/[id]/email, which files the text
              alongside the mail it answers, so both directions are real.

              Nothing new is invented here: the same ReplyComposer and the same
              /api/inbound-emails/[id]/reply route, which files the sent text into the Sent
              folder and only on a real send. The anchor is the latest mail this lead sent
              us, because that route deliberately refuses a caller-supplied `to` — the
              address comes from the stored enquiry, so nobody can send from this app to an
              address they typed in. */}
          {replyAnchor ? (
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">
                Reply by email
              </div>
              <ReplyComposer
                enquiryId={replyAnchor.id}
                /* Lets the composer offer "Draft with AI", which needs a thread to read. */
                leadId={lead.id}
                toEmail={replyAnchor.from_email}
                originalSubject={replyAnchor.subject}
                receivedAt={replyAnchor.created_at}
                formatWhen={formatDate}
                /* Built from the LEAD, not from the extractor: these fields have been
                   qualified by a human, and the extractor's guesses were only ever a
                   stand-in for that.

                   But the lead row is a snapshot of the FIRST enquiry. Once the customer
                   writes back, their newest message is newer information than the row —
                   reported 22 Aug 2026, when the pill restated "50 users of Business
                   Starter" to somebody whose reply had just changed it to 20 of Standard,
                   and then invited them to reply if the number changed. `factsSuperseded`
                   stops the pill asserting those fields; it does not try to guess the new
                   ones, because a template cannot read a correction. */
                context={{
                  contactName:     lead.contact_name,
                  product:         lead.plan,
                  seats:           lead.seats,
                  hasPhone:        Boolean(lead.contact_phone?.trim()),
                  sellerName:      currentUser?.tenantName ?? null,
                  /* NOT threadSummary.customerRepliedToUs — that asked "who wrote last", so
                     sending a reply cleared it and the very next draft restated the stale
                     figures (measured on this lead at 17:04 correct, 17:16 wrong). This asks
                     whether anyone has reconciled the lead with what the customer said. */
                  factsSuperseded: factsSuperseded({ thread: emailThread }),
                }}
              />
            </div>
          ) : lead.contact_email ? (
            /* No inbound mail to reply to — so there is no thread to attach a reply to, and
               saying that plainly beats a composer that cannot send. The Email button is
               still there; what it does NOT do is worth stating, because a logged
               "Emailed …" line looks like the mail was kept. */
            <div className="text-xs leading-snug text-ink-3 p-2.5 bg-paper-2 rounded-md">
              No email from this lead yet, so there is no thread to reply into. Use the{" "}
              <b className="text-ink-2">Email</b> button to write to them — it sends from
              your connected account and keeps the text, so it shows up in the Email tab.
              Once they write back, the reply box appears here too.
            </div>
          ) : null}
          </div>
  );
}
