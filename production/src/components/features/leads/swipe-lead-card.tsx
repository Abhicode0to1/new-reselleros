/**
 * SwipeLeadCard — mobile lead card with swipe-action gestures.
 *
 * Replaces the inline card list previously inside LeadListView. Goals:
 *   1. **Density** — fit 3-4 cards per phone screen instead of 2.
 *      The card is now 3 visual rows: header (co + ₹ + seats), contact line,
 *      meta+actions line (stage chip · follow-up · inline action icons).
 *   2. **Swipe gestures (the "power" layer)** —
 *        • Drag right ≥ 80px  →  Call (tel:)
 *        • Drag left  ≥ 80px  →  WhatsApp (wa.me with pre-filled msg)
 *      Action labels reveal behind the card as the user drags. Drag
 *      threshold under 80px = no action, card snaps back. Tap (no drag)
 *      = opens the detail drawer as before.
 *   3. **Stage quick-change** — small chip on the card opens a dropdown
 *      to flip stage without entering the drawer (preserved from v1).
 *
 * Built on framer-motion's `<motion.div drag>` so we don't reinvent
 * pointer-capture, momentum, or snap-back physics. The drag is constrained
 * to the X axis so the user can still scroll the list vertically.
 *
 * Action availability:
 *   - No phone on the lead   →  swipe gestures are disabled.
 *   - No email on the lead   →  the inline email icon hides.
 *   - hasContact === false   →  card stays static (drag disabled), tap-only.
 *
 * @example
 *   <SwipeLeadCard
 *     lead={lead}
 *     onTap={openDrawer}
 *     onChangeStage={(s) => updateStage.mutate({ id: lead.id, stage: s })}
 *   />
 */
"use client";

import * as React from "react";
import { motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, cn, formatDate } from "@/lib/utils";
import { intentMeta, staleWarning } from "@/lib/leads/heat";
import type { Lead } from "@/lib/supabase/database.types";

// LEAD_STAGES mirrors the array in leads/page.tsx — kept here as a small
// constant to avoid coupling the swipe card to that file's internals. If
// these labels diverge in the future we can lift to `lib/lead-stages.ts`.
const LEAD_STAGES: { id: Lead["stage"]; label: string; dot: string }[] = [
  { id: "new",     label: "New",          dot: "bg-slate"   },
  { id: "contact", label: "Contacted",    dot: "bg-amber"   },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo"  },
  { id: "trial",   label: "Trial Active", dot: "bg-rose"    },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo"  },
  { id: "won",     label: "Won",          dot: "bg-emerald" },
  { id: "lost",    label: "Lost",         dot: "bg-ink-3"   },
];

// Drag thresholds — anything under SWIPE_TRIGGER_PX is treated as a tap.
const SWIPE_TRIGGER_PX = 80;
const SWIPE_VELOCITY   = 400;  // fast-flick fallback when distance is short

interface SwipeLeadCardProps {
  lead: Lead;
  /** Tap (no drag) → open the lead drawer. */
  onTap: (lead: Lead) => void;
  /** Mutate the lead's stage when the user picks one from the chip menu. */
  onChangeStage: (stage: Lead["stage"]) => void;
  /** Direct "Send quote" — carries lead context into the quote builder. */
  onSendQuote?: (lead: Lead) => void;
  /**
   * Runs a call-outcome (lib/leads/outcomes.ts). Used by the left swipe and the
   * outcome chip row, so a gesture and a tap do exactly the same thing.
   */
  onOutcome?: (outcome: LeadOutcome, lead: Lead) => void;
  /** Earliest open follow-up task on this lead, if any (shows a chip). */
  task?: { due: string; overdue: boolean; count: number };
}

export function SwipeLeadCard({ lead, onTap, onChangeStage, onSendQuote, task }: SwipeLeadCardProps) {
  // Derived here rather than passed in, so the card is the single place that
  // decides how a lead looks on mobile — callers can't hand it a stale rule
  // that disagrees with the desktop table.
  const intent = intentMeta(lead);
  const stale7 = staleWarning(lead);
  const stageMeta = LEAD_STAGES.find((s) => s.id === lead.stage);

  // Quote-first funnel gating (mirrors the drawer + desktop row select):
  //  • Pre-quote lead (new/contact): only New / Contacted / Lost. To advance
  //    you must Send a quote (the 📄 icon), which moves it into Deals.
  //  • Post-quote deal: the deal stages only (no going back to the inbox).
  const isPreQuote = lead.stage === "new" || lead.stage === "contact";
  const stageOptions = LEAD_STAGES.filter((s) =>
    isPreQuote
      ? s.id === "new" || s.id === "contact" || s.id === "lost"
      : s.id !== "new" && s.id !== "contact",
  );

  // Phone normalisation for wa.me + tel: — assume Indian +91 if 10 digits.
  const phoneDigits = (lead.contact_phone ?? "").replace(/\D/g, "");
  const waNumber    = phoneDigits.startsWith("91")
    ? phoneDigits
    : (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits);
  const hasPhone    = phoneDigits.length >= 10;
  const hasEmail    = Boolean(lead.contact_email);

  const waMessage = buildWaMessage(lead);
  const followUp  = followUpLabel(lead.follow_up_date);
  const prio      = priorityDot(lead.priority);

  // ── Drag state ─────────────────────────────────────────────
  const x = useMotionValue(0);
  // Action backgrounds: emerald on right (call), indigo on left (WhatsApp).
  // Use absolute x so both reveals work regardless of direction.
  const callOpacity     = useTransform(x, [0, SWIPE_TRIGGER_PX], [0, 1]);
  const whatsAppOpacity = useTransform(x, [-SWIPE_TRIGGER_PX, 0], [1, 0]);

  // Track whether the gesture qualified as a drag — used to suppress the
  // tap-open on dragEnd (without this, a swipe also opens the drawer).
  const wasDragRef = React.useRef(false);

  const handleDragEnd = (_e: unknown, info: PanInfo) => {
    const distance = info.offset.x;
    const velocity = info.velocity.x;
    const triggered =
      Math.abs(distance) >= SWIPE_TRIGGER_PX ||
      Math.abs(velocity) >= SWIPE_VELOCITY;

    if (triggered) {
      wasDragRef.current = true;
      if (distance > 0 && hasPhone) {
        // Right swipe → Call
        window.location.href = `tel:${lead.contact_phone}`;
      } else if (distance < 0 && hasPhone) {
        // Left swipe → WhatsApp
        window.open(
          `https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`,
          "_blank",
          "noopener,noreferrer",
        );
      }
      // Clear the drag flag shortly so subsequent taps register.
      setTimeout(() => { wasDragRef.current = false; }, 250);
    } else if (Math.abs(distance) > 6) {
      // Movement happened but didn't reach threshold — still suppress tap.
      wasDragRef.current = true;
      setTimeout(() => { wasDragRef.current = false; }, 150);
    }
  };

  const handleCardTap = () => {
    if (wasDragRef.current) return;
    onTap(lead);
  };

  return (
    <li className="relative overflow-hidden rounded-lg">
      {/* Behind-card reveal panels — visible only as the card drags out
          of the way. Emerald = Call (right swipe), Indigo = WhatsApp
          (left swipe). pointer-events-none so they don't intercept taps. */}
      <motion.div
        className="absolute inset-y-0 left-0 w-1/2 flex items-center justify-start px-4 bg-emerald rounded-l-lg text-paper pointer-events-none"
        style={{ opacity: callOpacity }}
      >
        <Icon name="mobile" size={20} />
        <span className="ml-2 font-semibold text-sm">Call</span>
      </motion.div>
      <motion.div
        className="absolute inset-y-0 right-0 w-1/2 flex items-center justify-end px-4 bg-indigo rounded-r-lg text-paper pointer-events-none"
        style={{ opacity: whatsAppOpacity }}
      >
        <span className="mr-2 font-semibold text-sm">WhatsApp</span>
        <Icon name="whatsapp" size={20} />
      </motion.div>

      {/* The draggable card itself. drag is disabled when there's no phone
          (otherwise we'd reveal action panels that go nowhere). */}
      <motion.div
        drag={hasPhone ? "x" : false}
        dragConstraints={{ left: -120, right: 120 }}
        dragElastic={0.2}
        dragSnapToOrigin
        onDragEnd={handleDragEnd}
        style={{ x, touchAction: "pan-y" }}
        className="relative bg-paper border border-hairline rounded-lg"
        data-lead-id={lead.id}
      >
        {/* A div (not a <button>) so the action buttons inside it are valid HTML
            — a <button> can't contain <button>s (hydration error). Kept
            keyboard-accessible with role/tabIndex + Enter/Space. */}
        <div
          role="button"
          tabIndex={0}
          onClick={handleCardTap}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardTap(); } }}
          className="block w-full text-left p-3 active:bg-paper-2/50 rounded-lg cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/50"
        >
          {/* Row 1 — priority dot + company + ₹ value + seats. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn("w-2 h-2 rounded-full shrink-0", prio.color)} title={prio.title} />
                <p className="font-medium text-ink truncate text-[15px]">{lead.company}</p>
                {/* Intent tier + stale nudge — same lib/leads/heat helpers the
                    desktop table uses, so phone and desktop can never disagree
                    about the same lead. (The old `stale` prop used its own
                    14-day rule while the table used another — that drift is why
                    these live in one file now.) */}
                <span
                  title={`${intent.label} — ${intent.reason}`}
                  className={cn(
                    "shrink-0 inline-flex items-center rounded-full text-[10px] font-semibold px-1.5 py-0.5 leading-none",
                    intent.tier === "hot"  && "bg-rose-soft text-rose",
                    intent.tier === "warm" && "bg-amber-soft text-amber-ink",
                    intent.tier === "cold" && "bg-paper-3 text-ink-3 border border-hairline",
                  )}
                >
                  {intent.tier === "hot" ? "🔥" : intent.tier === "warm" ? "⚡" : "❄️"}
                </span>
                {stale7 && (
                  <span
                    title={stale7.message}
                    className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-soft/70 text-amber-ink text-[10px] font-semibold px-1.5 py-0.5 leading-none border border-amber/30"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                    {stale7.days}d
                  </span>
                )}
              </div>
              {/* Row 2 — contact name + phone, compact. */}
              {(lead.contact_name || lead.contact_phone) && (
                <p className="text-xs text-ink-3 truncate mt-0.5">
                  {lead.contact_name}
                  {lead.contact_phone && lead.contact_name && " · "}
                  {lead.contact_phone}
                </p>
              )}
              {task && (
                <span className={cn(
                  "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  task.overdue ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber-ink",
                )}>
                  <Icon name="clock" size={10} />
                  {task.overdue ? "Task overdue" : "Task"} · {formatDate(task.due)}
                  {task.count > 1 ? ` (+${task.count - 1})` : ""}
                </span>
              )}
            </div>
            {/* Right-rail: ₹ value + seats stacked. */}
            <div className="text-right shrink-0">
              <p className="font-serif text-base tabular-nums text-ink leading-none">
                {lead.value ? rupee(lead.value, { compact: true }) : "—"}
              </p>
              {lead.seats && (
                <p className="text-[10px] text-ink-3 tabular-nums mt-0.5">{lead.seats} seats</p>
              )}
            </div>
          </div>

          {/* Row 3 — stage chip + follow-up pill + inline action icons.
              All laid on a single line to compress the card height. */}
          <div className="flex items-center justify-between gap-2 mt-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {stageMeta && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-2 px-1.5 py-0.5 rounded hover:bg-paper-2 active:bg-paper-2/70 cursor-pointer shrink-0"
                    >
                      <span className={cn("w-1.5 h-1.5 rounded-full", stageMeta.dot)} />
                      {stageMeta.label}
                      <Icon name="chevron_down" size={10} className="text-ink-3" />
                    </span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">
                      Move {lead.company} to…
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {stageOptions.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        disabled={s.id === lead.stage}
                        onSelect={() => onChangeStage(s.id)}
                        className="text-sm"
                      >
                        <span className={cn("w-2 h-2 rounded-full mr-2", s.dot)} />
                        {s.label}
                        {s.id === lead.stage && (
                          <span className="ml-auto text-[10px] text-ink-3">current</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {followUp && (
                <span
                  className={cn(
                    "text-[10px] font-medium rounded-full px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1",
                    followUp.tone === "rose"  && "bg-rose-soft text-rose",
                    followUp.tone === "amber" && "bg-amber-soft text-amber-ink",
                    followUp.tone === "ink-3" && "bg-paper-2 text-ink-3",
                  )}
                >
                  <Icon name="clock" size={9} />
                  {followUp.text}
                </span>
              )}
              {/* Plan text — truncates when space tight. Shown for context. */}
              <span className="text-[11px] text-ink-3 truncate min-w-0">
                {lead.plan || "No plan"}
              </span>
            </div>

            {/* Inline action icons. Send-quote first (the funnel's key move —
                parity with the desktop row action), then Phone / WhatsApp /
                Email. ~32px tap targets meet Apple HIG minimum. */}
            <div className="flex items-center gap-1 shrink-0">
              {onSendQuote && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onSendQuote(lead); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-amber hover:bg-amber-soft/40 active:bg-amber-soft/60"
                  aria-label="Send quote"
                >
                  <Icon name="file" size={15} />
                </button>
              )}
              {hasPhone && (
                <a
                  href={`tel:${lead.contact_phone}`}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-emerald hover:bg-emerald-soft/40 active:bg-emerald-soft/60"
                  aria-label="Call"
                >
                  <Icon name="mobile" size={15} />
                </a>
              )}
              {hasPhone && (
                <a
                  href={`https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-emerald hover:bg-emerald-soft/40 active:bg-emerald-soft/60"
                  aria-label="WhatsApp"
                >
                  <Icon name="whatsapp" size={15} />
                </a>
              )}
              {hasEmail && (
                <a
                  href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email ?? "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md text-indigo hover:bg-indigo-50 active:bg-indigo/10"
                  aria-label="Email"
                >
                  <Icon name="mail" size={15} />
                </a>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </li>
  );
}

// ============================================================
// Helpers — kept inline to the swipe card so the file is self-contained.
// ============================================================

/** Pre-fill WhatsApp message with greeting + lead context. */
function buildWaMessage(lead: Lead): string {
  const greeting = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
  const ref = lead.plan
    ? `our conversation about ${lead.plan} for ${lead.company}`
    : `your inquiry for ${lead.company}`;
  return `${greeting} Following up on ${ref}. When's a good time for a quick call?`;
}

/** Follow-up date label. Returns null if no date set or far future. */
function followUpLabel(
  date: string | null,
): { text: string; tone: "rose" | "amber" | "ink-3" } | null {
  if (!date) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (date <  today)  return { text: "Overdue", tone: "rose"  };
  if (date === today) return { text: "Today",   tone: "amber" };
  const d = new Date(date);
  const text = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return { text, tone: "ink-3" };
}

/** Priority dot colour. */
function priorityDot(p: Lead["priority"] | undefined): { color: string; title: string } {
  if (p === "high")   return { color: "bg-rose",  title: "High priority"   };
  if (p === "medium") return { color: "bg-amber", title: "Medium priority" };
  return                    { color: "bg-slate", title: "Low priority"    };
}
