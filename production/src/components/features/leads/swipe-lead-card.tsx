/**
 * SwipeLeadCard — mobile lead card with swipe-action gestures.
 *
 * Replaces the inline card list previously inside LeadListView. Goals:
 *   1. **Density** — fit 3-4 cards per phone screen instead of 2.
 *      The card is now 3 visual rows: header (co + ₹ + seats), contact line,
 *      meta+actions line (stage chip · follow-up · inline action icons).
 *   2. **Swipe gestures (the "power" layer)** —
 *        • Drag right ≥ 80px  →  Contacted (stage → contact; refused if already past it)
 *        • Drag left  ≥ 80px  →  Snooze to tomorrow
 *        • Drag up    ≥ 80px  →  WhatsApp (wa.me with pre-filled msg)
 *      Was right = Call, left = WhatsApp. Two of the three now WRITE rather than merely
 *      opening something, which changes what a mis-swipe costs — the reasoning and every
 *      threshold live in lib/leads/swipe-gesture.ts.
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
import { toast } from "sonner";
import { rupee, cn, formatDate } from "@/lib/utils";
import { intentMeta, staleWarning } from "@/lib/leads/heat";
import { heatScore, heatBadge } from "@/lib/leads/heat-score";
import { decideSwipe, SWIPE_TRIGGER_PX } from "@/lib/leads/swipe-gesture";
import { OutcomeChips } from "./outcome-chips";
import type { LeadOutcome } from "@/lib/leads/outcomes";
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

// Drag thresholds now live in lib/leads/swipe-gesture.ts, beside the logic that uses
// them. Two copies of "80" is how a reveal panel ends up appearing at a different point
// from where the action actually fires.

interface SwipeLeadCardProps {
  lead: Lead;
  /** Tap (no drag) → open the lead drawer. */
  onTap: (lead: Lead) => void;
  /** Mutate the lead's stage when the user picks one from the chip menu. */
  onChangeStage: (stage: Lead["stage"]) => void;
  /** Direct "Send quote" — carries lead context into the quote builder. */
  onSendQuote?: (lead: Lead) => void;
  /**
   * Runs a call-outcome (lib/leads/outcomes.ts). Used by BOTH the left swipe and the
   * outcome chip row, so a gesture and a tap can never mean different things.
   */
  onOutcome?: (outcome: LeadOutcome, lead: Lead) => void;
  /** Earliest open follow-up task on this lead, if any (shows a chip). */
  task?: { due: string; overdue: boolean; count: number };
}

export function SwipeLeadCard({ lead, onTap, onChangeStage, onSendQuote, onOutcome, task }: SwipeLeadCardProps) {
  // Derived here rather than passed in, so the card is the single place that
  // decides how a lead looks on mobile — callers can't hand it a stale rule
  // that disagrees with the desktop table.
  const intent = intentMeta(lead);
  /* The 0-100 score. Kept alongside intentMeta because they answer different questions:
     intentTier is "should I act on this today", heatScore is "how good is this lead".
     A high-score lead that has gone quiet is the most valuable combination either can
     surface, and one number cannot say both. */
  const heat  = heatScore(lead);
  const badge = heatBadge(heat.band);
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

  /* ── Drag state ─────────────────────────────────────────────────────────────
     Right = contacted · left = snooze to tomorrow · up = WhatsApp. Which action a
     gesture means is decided by `decideSwipe` in lib/leads/swipe-gesture.ts — pure and
     fully tested, because you cannot assert on a finger and two of these three now
     WRITE to the lead. Read that file's header for why that changed the stakes. */
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const contactedOpacity = useTransform(x, [0, SWIPE_TRIGGER_PX], [0, 1]);
  const snoozeOpacity    = useTransform(x, [-SWIPE_TRIGGER_PX, 0], [1, 0]);
  const whatsAppOpacity  = useTransform(y, [-SWIPE_TRIGGER_PX, 0], [1, 0]);

  // Track whether the gesture qualified as a drag — used to suppress the
  // tap-open on dragEnd (without this, a swipe also opens the drawer).
  const wasDragRef = React.useRef(false);

  const handleDragEnd = (_e: unknown, info: PanInfo) => {
    const decision = decideSwipe({
      dx: info.offset.x, dy: info.offset.y,
      vx: info.velocity.x, vy: info.velocity.y,
      hasPhone, stage: lead.stage,
    });

    if (decision.wasDrag) {
      wasDragRef.current = true;
      // 250ms after a real action, 150ms after a mere half-swipe — long enough that the
      // pointer-up does not land as a tap, short enough not to eat the next one.
      const settle = decision.action ? 250 : 150;
      setTimeout(() => { wasDragRef.current = false; }, settle);
    }

    /* A refusal is spoken, not swallowed. Without this a rep swipes a quote-stage deal
       right, nothing happens, and they conclude the gesture is broken. */
    if (decision.refusal) { toast.info(decision.refusal); return; }

    switch (decision.action) {
      case "contacted":
        // Writes. onChangeStage is optimistic with rollback (queries/leads.ts).
        onChangeStage("contact");
        break;
      case "snooze":
        // Writes, via the same rule the outcome chips use — a gesture and a tap must
        // not be two different behaviours.
        onOutcome?.("call_tomorrow", lead);
        break;
      case "whatsapp":
        window.open(
          `https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`,
          "_blank",
          "noopener,noreferrer",
        );
        break;
      case null:
        break;
    }
  };

  const handleCardTap = () => {
    if (wasDragRef.current) return;
    onTap(lead);
  };

  return (
    <li className="relative overflow-hidden rounded-lg">
      {/* Behind-card reveal panels — visible only as the card drags out of the way, and
          each one NAMES its action before the gesture completes. That label is the only
          warning a rep gets before a write, which is why it reads "Contacted" and not a
          bare tick. Emerald right = Contacted · amber left = Tomorrow · indigo up =
          WhatsApp. pointer-events-none so they don't intercept taps. */}
      <motion.div
        className="absolute inset-y-0 left-0 w-1/2 flex items-center justify-start px-4 bg-emerald rounded-l-lg text-paper pointer-events-none"
        style={{ opacity: contactedOpacity }}
      >
        <Icon name="check" size={20} />
        <span className="ml-2 font-semibold text-sm">Contacted</span>
      </motion.div>
      <motion.div
        className="absolute inset-y-0 right-0 w-1/2 flex items-center justify-end px-4 bg-amber rounded-r-lg text-paper pointer-events-none"
        style={{ opacity: snoozeOpacity }}
      >
        <span className="mr-2 font-semibold text-sm">Tomorrow</span>
        <Icon name="clock" size={20} />
      </motion.div>
      <motion.div
        className="absolute inset-x-0 bottom-0 h-1/2 flex items-center justify-center bg-indigo rounded-b-lg text-paper pointer-events-none"
        style={{ opacity: whatsAppOpacity }}
      >
        <Icon name="whatsapp" size={20} />
        <span className="ml-2 font-semibold text-sm">WhatsApp</span>
      </motion.div>

      {/* The draggable card itself.
          `dragDirectionLock` is what makes a vertical gesture safe inside a vertically
          scrolling list: Framer commits to the axis the gesture STARTS on, so a page
          scroll can never be mistaken for an upward pull. decideSwipe's dominant-axis
          check is the second gate. Drag stays disabled with no phone — otherwise the
          panels would promise actions that cannot run. */}
      <motion.div
        drag={hasPhone ? true : false}
        dragDirectionLock
        dragConstraints={{ left: -120, right: 120, top: -110, bottom: 0 }}
        dragElastic={0.2}
        dragSnapToOrigin
        onDragEnd={handleDragEnd}
        style={{ x, y, touchAction: "pan-y" }}
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
                {/* The 0-100 heat score REPLACES the old emoji-only intent tier here
                    rather than sitting next to it. Two temperature badges with two
                    emoji sets (🔥/⚡/❄️ vs 🔥/☀️/❄️) on one card is exactly the drift
                    this file's own comment above warns about. The score is strictly
                    richer: it carries a number, so two hot leads are comparable, and a
                    tooltip that says WHY. `intent.reason` is folded into that tooltip so
                    nothing is lost. A "+" means some input was missing — see
                    lib/leads/heat-score.ts. */}
                <span
                  title={`${heat.score}/100 ${badge.label} · ${heat.reasons.join(" · ")}` +
                    (heat.incomplete ? "\n\nSome inputs are missing, so this is a floor, not a verdict." : "") +
                    `\n\nAct-now signal: ${intent.label} — ${intent.reason}`}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-0.5 rounded-full text-[10px] font-semibold px-1.5 py-0.5 leading-none tabular-nums",
                    heat.band === "hot"  && "bg-rose-soft text-rose",
                    heat.band === "warm" && "bg-amber-soft text-amber-ink",
                    heat.band === "cold" && "bg-paper-3 text-ink-3 border border-hairline",
                  )}
                >
                  {badge.emoji} {heat.score}{heat.incomplete ? "+" : ""}
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

            {/* Inline CONTACT icons — Phone / WhatsApp / Email. ~32px tap targets, Apple
                HIG minimum.

                The 📄 Send-quote icon that used to lead this row is GONE — the outcome
                chip below does the same thing with a readable label, and two controls
                with aria-label "Send quote" on one card meant a screen reader announced
                it twice.

                Call / WhatsApp / Email STAY. They are contact actions, not outcomes, and
                they are the only ones of their kind on the card: right-swipe used to dial
                and now marks contacted, so removing this row would leave a call-first
                sales tool with no way to place a call from a lead card. The priority
                queue's big Call button only covers the three leads due today. */}
            <div className="flex items-center gap-1 shrink-0">
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

          {/* The four outcome chips — the same component and the same rules the call
              queue and the desktop row use. A rep who learns these four once knows them
              everywhere.

              They matter MORE on mobile than the gestures do: a gesture is invisible
              until someone tells you it exists, and nobody reads release notes. The
              chips are the discoverable path; the swipes are the shortcut for whoever
              finds them. */}
          {onOutcome && (
            <OutcomeChips
              className="mt-2 border-t border-hairline pt-2"
              hasPhone={hasPhone}
              /* "Send quote" prefers the caller's own handler when it has one. The page's
                 goSendQuote carries contact name, email and phone into the quote builder
                 as well as the plan and seats — more than the generic navigation in
                 use-outcome.ts. Routing through it keeps the chip and the desktop row's
                 icon doing exactly the same thing. */
              onPick={(o) => {
                if (o === "send_quote" && onSendQuote) { onSendQuote(lead); return; }
                onOutcome(o, lead);
              }}
            />
          )}

          {/* And the gestures, said out loud once per card. Cheap, and the only reason
              anyone will discover a three-way swipe. */}
          {hasPhone && (
            <p className="mt-1.5 text-[10px] leading-none text-ink-3">
              Swipe → contacted · ← tomorrow · ↑ WhatsApp
            </p>
          )}
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
