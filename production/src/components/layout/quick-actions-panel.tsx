/**
 * QuickActionsPanel — page-aware "what should I do now" full-screen sheet.
 *
 * Surfaced via a sparkles button in the TopBar (right next to the bell).
 * Tap → a full-screen Dialog opens with sections of important actions for
 * the user's CURRENT page. The bell shows things that need attention
 * (notifications, due tasks); this shows things you can DO right now.
 *
 * Page coverage (first cut):
 *   /leads + /deals  →  full Leads playbook (due today, hot leads, capture,
 *                       bulk operations)
 *   other pages      →  empty state ("no quick actions for this page yet")
 *
 * Actions that need to open dialogs on the current page (Quick add lead,
 * Full add, Import CSV, etc.) navigate to `<page>?action=<id>`. The
 * destination page reads the `?action=` search param on mount and opens
 * the matching dialog, then router.replace's the param away so a refresh
 * doesn't re-open it. This pattern already exists for `?lead=L-XXX` deep
 * links on the Leads page.
 *
 * Mobile: panel is full viewport (h-screen, !rounded-none). Desktop: max
 * width 2xl, max height 90vh, rounded card.
 *
 * @example
 *   <QuickActionsPanel open={open} onOpenChange={setOpen} />
 */
"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import type { Route } from "next";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { useLeads } from "@/lib/queries/leads";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface QuickActionsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickActionsPanel({ open, onOpenChange }: QuickActionsPanelProps) {
  const pathname = usePathname();
  const isLeadsContext = pathname === "/leads" || pathname === "/deals";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Full-screen on mobile, large card on desktop. */}
      <DialogContent
        className={cn(
          "p-0 gap-0 overflow-hidden",
          // Mobile: cover viewport, no rounded corners
          "!max-w-full w-screen h-[100dvh] !max-h-[100dvh] !rounded-none",
          // Desktop: roomy card, scrollable
          "md:!max-w-2xl md:w-auto md:h-auto md:!max-h-[90vh] md:!rounded-lg",
        )}
      >
        {/* Sticky header — stays visible while sections scroll */}
        <div className="sticky top-0 z-10 bg-paper border-b border-hairline px-5 py-4">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl flex items-center gap-2">
              <Icon name="sparkles" size={20} className="text-amber" />
              Quick actions
            </DialogTitle>
            <DialogDescription>
              {isLeadsContext
                ? "What needs attention on your leads board right now."
                : "Important things you can do from here."}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Body — scrollable region. Add bottom padding so safe-area on
            iOS notch devices doesn't clip the last action card. */}
        <div className="flex-1 overflow-y-auto px-5 py-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          {isLeadsContext ? (
            <LeadsActions onClose={() => onOpenChange(false)} />
          ) : (
            <GenericActions />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Leads / Deals — full playbook
// ============================================================
function LeadsActions({ onClose }: { onClose: () => void }) {
  const router            = useRouter();
  const pathname          = usePathname();
  const { data: leads }   = useLeads();
  const { data: me }      = useCurrentUser();
  // Sales role gets the same capture actions but the bulk operations
  // (Import CSV, Send campaign, Start trial) are hidden — same gating
  // pattern as on the page header toolbar.
  const isSales = me?.role === "sales";

  // ─── Pending today + overdue ──────────────────────────────
  const todayStr   = new Date().toISOString().slice(0, 10);
  const dueToday   = (leads ?? []).filter((l) => l.follow_up_date === todayStr);
  const overdue    = (leads ?? []).filter((l) => l.follow_up_date && l.follow_up_date < todayStr);

  // ─── Hot leads — top 3 by value in late stages ────────────
  const hotLeads = (leads ?? [])
    .filter((l) => l.stage === "quote" || l.stage === "trial" || l.stage === "demo")
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3);

  /**
   * Trigger a page-level action by pushing a `?action=` URL. The Leads
   * page picks it up via useSearchParams + opens the corresponding modal.
   * We close the panel first so the modal lands on top of the actual page.
   */
  const triggerAction = (action: string) => {
    onClose();
    // Navigate to /leads (keep deals action on /leads — same data, same modals)
    const target = pathname === "/deals" ? "/deals" : "/leads";
    router.push(`${target}?action=${action}` as Route);
  };

  /** Open a specific lead drawer by ID via the existing ?lead= deep link. */
  const openLead = (id: string) => {
    onClose();
    const target = pathname === "/deals" ? "/deals" : "/leads";
    router.push(`${target}?lead=${id}` as Route);
  };

  return (
    <div className="space-y-6">
      {/* Section: Pending today / overdue.
          Most important — if there's something due NOW, surface it loudly.
          Hidden when both buckets are empty. */}
      {(dueToday.length > 0 || overdue.length > 0) && (
        <Section title="Pending today">
          <div className="grid grid-cols-2 gap-3">
            {dueToday.length > 0 && (
              <ActionCard
                icon="clock"
                title={`${dueToday.length} due today`}
                description="Follow-ups scheduled for today"
                tone="amber"
                onClick={() => triggerAction("today")}
              />
            )}
            {overdue.length > 0 && (
              <ActionCard
                icon="alert"
                title={`${overdue.length} overdue`}
                description="Missed follow-ups — call now"
                tone="rose"
                onClick={() => triggerAction("overdue")}
              />
            )}
          </div>
        </Section>
      )}

      {/* Section: Hot leads.
          Quote/trial/demo stage rows sorted by value — the ones MOST likely
          to close this week. Tap → opens the lead drawer directly. */}
      {hotLeads.length > 0 && (
        <Section title="Top hot leads">
          <div className="space-y-2">
            {hotLeads.map((lead) => (
              <button
                key={lead.id}
                onClick={() => openLead(lead.id)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-paper-2 hover:bg-paper border border-hairline text-left transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink text-sm truncate">{lead.company}</div>
                  <div className="text-xs text-ink-3 truncate">
                    {lead.plan ?? "No plan"} · {lead.seats ?? "—"} seats
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <Badge kind="warning" size="sm" className="capitalize">{lead.stage}</Badge>
                  <span className="font-serif text-sm text-ink tabular-nums">
                    {lead.value ? rupee(lead.value, { compact: true }) : "—"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Section: Capture a new lead.
          Two paths — fast (4 fields) and full (everything). Same buttons
          you see on the FAB / header, but here they're discoverable + side-
          by-side so the trade-off is obvious. */}
      <Section title="Capture a new lead">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ActionCard
            icon="zap"
            title="Quick add"
            description="4 fields — name + contact only"
            tone="amber-soft"
            onClick={() => triggerAction("quick-add")}
          />
          <ActionCard
            icon="plus"
            title="Full lead form"
            description="Plan, seats, priority, owner, notes"
            tone="default"
            onClick={() => triggerAction("add")}
          />
        </div>
      </Section>

      {/* Section: Bulk operations.
          Owner / manager only — sales role doesn't see these. Same logic
          as the page header toolbar so behavior stays consistent. */}
      {!isSales && (
        <Section title="Bulk operations">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ActionCard
              icon="globe"
              title="Import Google contacts"
              description="Pull leads from your Google account"
              tone="default"
              onClick={() => triggerAction("import-google")}
            />
            <ActionCard
              icon="send"
              title="Send campaign"
              description="Bulk email / WhatsApp blast"
              tone="default"
              onClick={() => triggerAction("campaign")}
            />
            <ActionCard
              icon="clock"
              title="Start a trial"
              description="Provision a 14-day workspace"
              tone="default"
              onClick={() => triggerAction("trial")}
            />
            <ActionCard
              icon="download"
              title="Import CSV"
              description="Upload leads from a spreadsheet"
              tone="default"
              onClick={() => triggerAction("import-csv")}
            />
          </div>
        </Section>
      )}
    </div>
  );
}

// ============================================================
// Other pages — placeholder for future page-specific playbooks
// ============================================================
function GenericActions() {
  return (
    <div className="text-center py-16">
      <Icon name="sparkles" size={36} className="text-ink-3 mx-auto mb-3" />
      <p className="text-sm text-ink">No quick actions for this page yet.</p>
      <p className="text-xs text-ink-3 mt-1">
        Try this from the Leads or Deals page for the full playbook.
      </p>
    </div>
  );
}

// ============================================================
// Building blocks
// ============================================================
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-3xs uppercase font-semibold text-ink-3 tracking-[0.1em] mb-2.5">
        {title}
      </h3>
      {children}
    </section>
  );
}

type ActionTone = "default" | "amber" | "amber-soft" | "rose";

interface ActionCardProps {
  icon: string;
  title: string;
  description: string;
  tone: ActionTone;
  onClick: () => void;
}

function ActionCard({ icon, title, description, tone, onClick }: ActionCardProps) {
  // Tones map: each one pairs a background + an icon foreground. The
  // "amber" (filled, attention-grabbing) is reserved for items that genuinely
  // demand a "do this now" response — overdue, due today.
  const wrapper: Record<ActionTone, string> = {
    default:      "bg-paper-2 hover:bg-paper border-hairline text-ink",
    amber:        "bg-amber text-paper border-amber/0 hover:brightness-105 shadow-md shadow-amber/20",
    "amber-soft": "bg-amber-soft border-amber/30 text-amber-ink hover:bg-amber-soft/70",
    rose:         "bg-rose/10 border-rose/30 text-rose hover:bg-rose/15",
  };
  const iconClass: Record<ActionTone, string> = {
    default:      "text-amber",
    amber:        "text-paper",
    "amber-soft": "text-amber-ink",
    rose:         "text-rose",
  };

  return (
    <button
      onClick={onClick}
      className={cn(
        "p-4 rounded-lg border text-left transition-all min-h-[104px] flex flex-col gap-1.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
        wrapper[tone],
      )}
    >
      <Icon name={icon} size={20} className={iconClass[tone]} />
      <div className="font-semibold text-sm mt-1">{title}</div>
      <div className="text-xs opacity-80 leading-snug">{description}</div>
    </button>
  );
}
