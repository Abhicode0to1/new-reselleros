/**
 * PriorityCallQueue — "🔥 Today's Priority Call Queue".
 *
 * The top of the Leads page: the three leads to ring right now, each with a Call and a
 * WhatsApp button big enough for a thumb, plus the four outcome chips so the rep can
 * record what happened without leaving the bar.
 *
 * ─── WHY THE BUTTONS ARE LINKS AND NOT AN INTEGRATION ───────────────────────
 * `tel:` and `https://wa.me/…` hand off to the phone's own dialler and WhatsApp app.
 * That is not a shortcut around a missing feature — it is the right mechanism for a rep
 * on a phone, and critically it needs NO credentials. The Gupshup WhatsApp keys on this
 * project are unset; a "send" button routed through the API would have failed or, worse,
 * fallen back to a stub and reported success for a message nobody received.
 *
 * ─── WHY IT SHOWS THE COUNT IT IS HIDING ────────────────────────────────────
 * The bar shows 3 of however many are due and says so ("3 of 11"). A queue that
 * silently truncates reads as "that's everything today" — which is how a rep finishes
 * their list at 11am and stops.
 *
 * ─── AND WHY IT MENTIONS THE UNREACHABLE ONES ───────────────────────────────
 * Leads due today with no phone number cannot be in a call queue. They are named
 * anyway, with a link, because a missing number is a two-second fix that nobody makes
 * if nothing ever mentions it.
 *
 * Self-hiding: nothing due, nothing rendered. A permanent "no calls today" panel is
 * the fastest way to teach someone to ignore the top of the page.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, cleanDisplayName } from "@/lib/utils";
import { buildCallQueue, queueWhatsAppMessage, dialable, type QueueEntry } from "@/lib/leads/call-queue";
import { heatBadge } from "@/lib/leads/heat-score";
import { OutcomeChips } from "./outcome-chips";
import type { LeadOutcome } from "@/lib/leads/outcomes";
import type { Lead } from "@/lib/supabase/database.types";

function overdueLabel(days: number): { text: string; kind: "danger" | "warning" } {
  if (days <= 0) return { text: "Due today", kind: "warning" };
  if (days === 1) return { text: "1 day late", kind: "danger" };
  return { text: `${days} days late`, kind: "danger" };
}

function QueueRow({
  entry, tenantName, onOutcome, onOpen, onLogCall, onLogWhatsApp,
}: {
  entry: QueueEntry;
  tenantName?: string | null;
  onOutcome: (o: LeadOutcome, l: Lead) => void;
  onOpen: (l: Lead) => void;
  onLogCall: (l: Lead) => void;
  onLogWhatsApp: (l: Lead) => void;
}) {
  const { lead, heat, daysOverdue } = entry;
  const badge = heatBadge(heat.band);
  const late  = overdueLabel(daysOverdue);
  const num   = dialable(lead.contact_phone);
  const waMsg = queueWhatsAppMessage(lead, tenantName);

  return (
    <li className="border-b border-hairline px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(lead)}
              className="truncate text-sm font-semibold text-ink hover:underline"
            >
              {cleanDisplayName(lead.company)}
            </button>
            {/* Score AND band. The number is what makes two hot leads comparable. */}
            <Badge
              kind={badge.kind}
              size="sm"
              title={`${heat.score}/100 · ${heat.reasons.join(" · ")}${heat.incomplete ? "\n\nSome inputs are missing, so this is a floor, not a verdict." : ""}`}
            >
              {badge.emoji} {heat.score}{heat.incomplete ? "+" : ""}
            </Badge>
            <Badge kind={late.kind} size="sm">{late.text}</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-3">
            {lead.contact_name ? `${lead.contact_name} · ` : ""}
            {lead.contact_phone}
            {lead.plan ? ` · ${lead.plan}` : ""}
            {lead.seats ? ` · ${lead.seats} seats` : ""}
            {(lead.value ?? 0) > 0 ? ` · ${rupee(lead.value ?? 0)}` : ""}
          </p>
        </div>

        {/* The two big ones. Anchors, so the OS handles them — and so a long-press
            gives the rep "copy number" for free. */}
        <div className="flex items-center gap-2">
          <a
            href={`tel:${num ?? ""}`}
            onClick={(e) => {
              if (!num) { e.preventDefault(); toast.error(`${lead.company} has no usable phone number`); return; }
              onLogCall(lead);
            }}
            className={cn(
              "inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold",
              "bg-primary text-white hover:opacity-90",
            )}
          >
            <Icon name="mobile" size={14} /> Call now
          </a>
          <a
            href={num ? `https://wa.me/${num}?text=${encodeURIComponent(waMsg)}` : "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!num) { e.preventDefault(); toast.error(`${lead.company} has no usable phone number`); return; }
              onLogWhatsApp(lead);
            }}
            title={waMsg}
            className={cn(
              "inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 text-xs font-bold",
              "border-emerald/50 bg-emerald-soft/40 text-emerald hover:bg-emerald-soft/70",
            )}
          >
            <Icon name="whatsapp" size={14} /> WhatsApp
          </a>
        </div>
      </div>

      {/* Record the outcome without leaving the bar — the whole point of a call list. */}
      <OutcomeChips
        className="mt-2"
        hasPhone={Boolean(num)}
        onPick={(o) => onOutcome(o, lead)}
      />
    </li>
  );
}

export function PriorityCallQueue({
  leads, tenantName, onOutcome, onOpen, onLogCall, onLogWhatsApp, limit = 3,
}: {
  leads: readonly Lead[];
  tenantName?: string | null;
  onOutcome: (o: LeadOutcome, l: Lead) => void;
  onOpen: (l: Lead) => void;
  onLogCall: (l: Lead) => void;
  onLogWhatsApp: (l: Lead) => void;
  limit?: number;
}) {
  const queue = React.useMemo(() => buildCallQueue(leads, limit), [leads, limit]);

  // Nothing due and nobody unreachable → render nothing at all.
  if (queue.entries.length === 0 && queue.dueWithoutPhone.length === 0) return null;

  const hidden = queue.dueCount - queue.entries.length;

  return (
    <Card
      flush
      className="border-amber/40"
      title={<span className="flex items-center gap-2">🔥 Today&apos;s priority call queue</span>}
      sub={
        queue.entries.length > 0
          ? `${queue.entries.length} of ${queue.dueCount} due` +
            (queue.overdueCount > 0 ? ` · ${queue.overdueCount} already late` : "")
          : "Everything due today is missing a phone number"
      }
    >
      {queue.entries.length > 0 && (
        <ul>
          {queue.entries.map((e) => (
            <QueueRow
              key={e.lead.id}
              entry={e}
              tenantName={tenantName}
              onOutcome={onOutcome}
              onOpen={onOpen}
              onLogCall={onLogCall}
              onLogWhatsApp={onLogWhatsApp}
            />
          ))}
        </ul>
      )}

      {/* The truncation, stated. Not "and more" — the actual number. */}
      {hidden > 0 && (
        <p className="border-t border-hairline bg-paper-2 px-4 py-2 text-[11px] text-ink-3">
          {hidden} more due today, below the top {queue.entries.length}. Work through these
          first — the list re-sorts as you clear them.
        </p>
      )}

      {/* The unreachable ones, named. */}
      {queue.dueWithoutPhone.length > 0 && (
        <p className="border-t border-hairline px-4 py-2.5 text-[11px] leading-relaxed text-ink-2">
          <b>{queue.dueWithoutPhone.length} due today with no phone number</b> —{" "}
          {queue.dueWithoutPhone.slice(0, 3).map((l) => cleanDisplayName(l.company)).join(", ")}
          {queue.dueWithoutPhone.length > 3 ? ` +${queue.dueWithoutPhone.length - 3} more` : ""}.
          They cannot be called until someone adds one.{" "}
          <Link href="/leads?view=all" className="font-semibold text-primary hover:underline">
            Open the inbox
          </Link>{" "}
          to fill them in.
        </p>
      )}
    </Card>
  );
}
