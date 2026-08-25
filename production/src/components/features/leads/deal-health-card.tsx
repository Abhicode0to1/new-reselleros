"use client";

/**
 * Deal health, shown as a score and — more usefully — as the list of things to fix.
 *
 * The score is the headline because it sorts; the issues are the reason the card exists.
 * "62" tells a rep nothing to do. "No follow-up booked. No reply from the customer yet."
 * is a to-do list, and it is the same list the score was computed from, so the number
 * can never disagree with the advice underneath it.
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { DealHealth } from "@/lib/leads/deal-health";
import { healthBadge } from "@/lib/leads/deal-health";

const BAND_TEXT: Record<string, string> = {
  healthy:  "Being worked well",
  slipping: "Starting to slip",
  at_risk:  "At risk of going cold",
  unknown:  "Closed — no health to report",
};

export function DealHealthCard({ health, onBookFollowUp }: {
  health: DealHealth;
  onBookFollowUp?: () => void;
}) {
  const badge = healthBadge(health);
  if (health.band === "unknown") return null;

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        badge.kind === "danger"  && "border-rose/30 bg-rose-soft/30",
        badge.kind === "warning" && "border-amber/30 bg-amber-soft/30",
        badge.kind === "success" && "border-emerald/30 bg-emerald-soft/30",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Deal health</p>
          <p className="text-sm font-medium text-ink mt-0.5">{BAND_TEXT[health.band]}</p>
        </div>
        <div className="text-right shrink-0">
          <p
            className={cn(
              "font-serif text-2xl font-semibold leading-none",
              badge.kind === "danger"  && "text-rose",
              badge.kind === "warning" && "text-amber-ink",
              badge.kind === "success" && "text-emerald",
            )}
          >
            {badge.label}
          </p>
          <p className="text-3xs text-ink-3 mt-0.5">out of 100</p>
        </div>
      </div>

      {health.issues.length > 0 && (
        <ul className="mt-2.5 space-y-1 border-t border-hairline/60 pt-2.5">
          {health.issues.map((issue) => (
            <li key={issue} className="flex items-start gap-1.5 text-[12px] leading-snug text-ink-2">
              <Icon name="alert" size={11} className="mt-[3px] shrink-0 text-ink-3" />
              <span>{issue}</span>
            </li>
          ))}
        </ul>
      )}

      {/* §24 — a block must name the next step and give a way to take it. "No follow-up
          booked" has exactly one fix and this is the button for it. */}
      {onBookFollowUp && health.issues.some((i) => /follow-up/i.test(i)) && (
        <button
          type="button"
          onClick={onBookFollowUp}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-2xs font-semibold text-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          <Icon name="calendar" size={12} /> Book a follow-up
        </button>
      )}

      {health.incomplete && (
        <p className="mt-2 text-3xs leading-snug text-ink-3">
          The <b>+</b> means part of this could not be measured, so the real score is at least this high.
        </p>
      )}
    </div>
  );
}
