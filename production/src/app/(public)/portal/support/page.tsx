/**
 * /portal/support — customer-side support inbox.
 *
 * Customers can:
 *   • Raise a new ticket (category, priority, subject, body)
 *   • See all their past tickets with current status
 *   • Get a clear "Pardeep will respond" expectation
 *
 * Reseller-side ticket management lives at /support (Engage section).
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";
import { tenantWhatsAppLink, phoneDisplay } from "@/lib/portal/branding";
import { RateTicket } from "@/components/features/support/ticket-rating";

export const dynamic = "force-dynamic";

/* Badge takes `kind`, not `color`. Every one of these pills was passing
   `color=` — which BadgeProps accepts only because it extends
   HTMLAttributes, so it landed on the <span> as a dead DOM attribute and
   the badge rendered muted grey whatever the status was: paid, overdue and
   draft all looked identical. Fixed 8 Sep 2026. */
const STATUS_KIND: Record<string, "success" | "warning" | "danger" | "muted" | "info"> = {
  open:              "danger",
  in_progress:       "warning",
  awaiting_customer: "info",
  resolved:          "success",
  closed:            "muted",
};

const STATUS_LABEL: Record<string, string> = {
  open:              "Open · awaiting response",
  in_progress:       "In progress",
  awaiting_customer: "Awaiting your reply",
  resolved:          "Resolved",
  closed:            "Closed",
};

export default async function PortalSupportPage() {
  const session  = await requirePortalSession();
  const reseller = session.tenantContactName ?? session.tenantName;
  const waLink   = tenantWhatsAppLink(session.tenantPhone, `Hi ${reseller}, I need urgent help.`);
  const supabase = createClient();

  const { data: tickets } = await supabase
    .from("support_tickets")
    .select("id, category, priority, subject, body, status, created_at, resolved_at, resolution_note")
    .order("created_at", { ascending: false });

  const rows = tickets ?? [];
  const openCount = rows.filter((t) => t.status !== "resolved" && t.status !== "closed").length;

  /* Ratings the customer already gave — RLS hands back only their own. One query
     for the whole page; the map keeps the card render O(1). */
  const { data: ratingRows } = await supabase
    .from("support_ticket_ratings")
    .select("ticket_id, score, comment");
  const ratingByTicket = new Map(
    (ratingRows ?? []).map((r) => [r.ticket_id, { score: r.score, comment: r.comment }]),
  );

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Support</h1>
          <p className="text-sm text-ink-3 mt-1">
            Raise issues here for a written trail.
            {waLink && (
              <>
                {" "}For urgent items, WhatsApp {reseller} on{" "}
                <a href={waLink} target="_blank" rel="noopener noreferrer" className="text-amber-ink hover:underline">
                  {phoneDisplay(session.tenantPhone)}
                </a>.
              </>
            )}
          </p>
        </div>
        <Button asChild variant="primary">
          <Link href="/portal/support/new">
            <Icon name="plus" size={14} className="mr-1.5" />
            New ticket
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-paper-2 grid place-items-center">
            <Icon name="ticket" size={26} className="text-ink-3" />
          </div>
          <h2 className="font-serif text-xl mb-2">No tickets yet</h2>
          <p className="text-sm text-ink-3 mb-5 max-w-md mx-auto">
            Have a billing question, technical issue, or want to change your plan?
            Raise a ticket — {reseller} responds within 4 business hours.
          </p>
          <Button asChild variant="primary">
            <Link href="/portal/support/new">
              <Icon name="plus" size={14} className="mr-1.5" />
              Raise your first ticket
            </Link>
          </Button>
        </Card>
      ) : (
        <>
          {openCount > 0 && (
            <Card className="p-4 mb-5 bg-amber-soft/30 border-amber/30">
              <div className="text-sm text-ink-2">
                <Icon name="info" size={14} className="text-amber-ink inline mr-1 align-text-bottom" />
                <b>{openCount} {openCount === 1 ? "ticket is" : "tickets are"}</b> open or in progress.
                {" "}{reseller} responds within 4 business hours.
              </div>
            </Card>
          )}

          <div className="space-y-3">
            {rows.map((t) => (
              <Card key={t.id} className="p-5">
                <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink leading-tight">{t.subject}</div>
                    <div className="text-2xs text-ink-3 mt-0.5">
                      <span className="font-mono">{t.id}</span>
                      <span className="mx-1.5">·</span>
                      {formatDate(t.created_at.slice(0, 10))}
                      <span className="mx-1.5">·</span>
                      {t.category.replace("_", " ")}
                      {t.priority !== "normal" && (
                        <>
                          <span className="mx-1.5">·</span>
                          <span className={t.priority === "urgent" ? "text-rose font-semibold" : "text-amber-ink"}>
                            {t.priority} priority
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <Badge kind={STATUS_KIND[t.status] ?? "muted"}>
                    {STATUS_LABEL[t.status] ?? t.status}
                  </Badge>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed line-clamp-3">{t.body}</p>
                {t.resolution_note && (
                  <div className="mt-3 p-3 rounded-md bg-emerald-soft/40 border border-emerald/20 text-xs">
                    <div className="text-3xs uppercase tracking-wider text-emerald font-semibold mb-1">
                      {reseller}&apos;s response
                    </div>
                    <p className="text-ink-2 leading-relaxed">{t.resolution_note}</p>
                  </div>
                )}
                {/* CSAT — only a FINISHED ticket can be scored (the DB refuses the rest;
                    the UI simply doesn't ask). One verdict per ticket. */}
                {(t.status === "resolved" || t.status === "closed" || t.resolved_at) && (
                  <RateTicket
                    ticketId={t.id}
                    tenantId={session.tenantId}
                    ratedByEmail={session.userEmail}
                    existing={ratingByTicket.get(t.id) ?? null}
                  />
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
