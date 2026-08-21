/**
 * "N quotes need your approval" — the strip at the top of the Quotes list.
 *
 * ─── WHY IT IS ITS OWN COMPONENT ────────────────────────────────────────────
 * It cannot be browser-verified from this machine. The one pending quote in the live books
 * was raised BY the only login available here, and a person cannot approve their own quote,
 * so the running app correctly shows this strip to nobody. Seeing it render would mean
 * either signing in as the other owner or editing a live quote's approval fields, and
 * neither is worth doing for a screenshot. Pulled out here, it gets a real render test
 * instead — the same component, with the rows a real queue would carry.
 *
 * ─── NOT A STATUS TAB ───────────────────────────────────────────────────────
 * These quotes are already counted under Draft or Sent. A second count in the same row of
 * tabs gets read as a total — the mistake this codebase has made twice — so this sits
 * above them and is worded as a filter over the list, not a folder in it.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface ApprovalsStripProps {
  /** How many quotes are waiting on the person reading this. Zero renders nothing. */
  count: number;
  /** Is the list currently filtered down to just those? */
  filtered: boolean;
  onToggle: (next: boolean) => void;
}

export function ApprovalsStrip({ count, filtered, onToggle }: ApprovalsStripProps) {
  /* Silence at zero. A strip that is always present is a strip nobody reads, and the whole
     point is that it means somebody is blocked. */
  if (count <= 0) return null;
  const one = count === 1;

  return (
    <div
      /* A live region: this count arrives after the first paint and can change while the
         page is open, so a screen reader needs to be told rather than having to go looking. */
      role="status"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber/40 bg-amber-soft px-3.5 py-2.5"
    >
      <Icon name="shield" size={16} className="shrink-0 text-amber-ink" />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-amber-ink">
        <b>
          {count} quote{one ? "" : "s"} need{one ? "s" : ""} your approval.
        </b>{" "}
        {/* Says what is at stake, not just that a queue exists. A rep is waiting: until
            this is cleared the quote cannot be sent to the customer at all. */}
        Nobody else can send {one ? "it" : "them"} until you decide.
      </p>
      <Button
        size="sm"
        variant={filtered ? "default" : "primary"}
        icon={filtered ? "x" : "filter"}
        onClick={() => onToggle(!filtered)}
      >
        {filtered ? "Show all quotes" : one ? "Review it" : "Review them"}
      </Button>
    </div>
  );
}
