/**
 * "My assigned" vs "Team view", plus the sentence that says what that means.
 *
 * ─── IT SAYS WHOSE TEAM, AND HOW MANY ───────────────────────────────────────
 * "Team view" on its own does not tell an operator whose team they are looking at, and a
 * manager with two reports and a manager with forty need different things from the same
 * screen. So the note under it counts the people in scope.
 *
 * ─── AND IT IS HONEST THAT THIS IS A VIEW, NOT A WALL ───────────────────────
 * Until the hierarchy RLS migration is applied, this narrows what the SCREEN shows and
 * nothing more — the API still serves every row in the tenant to anyone signed into it.
 * The component says so, once, quietly, rather than letting a filter be mistaken for
 * privacy. A UI that hides a peer's leads looks identical to one that cannot serve them,
 * and that is precisely how somebody concludes isolation is finished when it is not.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  showsTeamToggle, scopeNote, type ScopeCounts, type TeamMember, type TeamViewMode,
} from "@/lib/team/visibility";

export interface TeamViewToggleProps {
  me: TeamMember | null;
  all: readonly TeamMember[];
  mode: TeamViewMode;
  onChange: (m: TeamViewMode) => void;
  /**
   * Whether row-level enforcement is live. False today; the migration flips it.
   * Passed in rather than read from a constant so the day it becomes true, one call site
   * changes and the caveat disappears everywhere at once.
   */
  enforcedInDatabase?: boolean;
  /**
   * How many rows are in view and how many of them have no owner.
   *
   * Optional, but a caller that omits it gets the old note — which claimed "only records
   * assigned to you" while showing rows assigned to nobody. Pass it.
   */
  counts?: ScopeCounts;
  className?: string;
}

export function TeamViewToggle({
  me, all, mode, onChange, enforcedInDatabase = false, counts, className,
}: TeamViewToggleProps) {
  /* Hidden entirely when both halves would show the same rows — see showsTeamToggle. A
     control that does nothing teaches people that controls do nothing. */
  if (!me || !showsTeamToggle(me, all)) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <div className="inline-flex rounded-lg border border-hairline p-0.5" role="group" aria-label="Whose records to show">
        {(["mine", "team"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={mode === m}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] transition-colors",
              mode === m ? "bg-ink text-paper font-semibold" : "text-ink-2 hover:bg-paper-2",
            )}
          >
            {m === "mine" ? "My assigned" : "Team view"}
          </button>
        ))}
      </div>

      <p className="text-[11px] leading-snug text-ink-3">
        {scopeNote(me, all, mode, counts)}{" "}
        {!enforcedInDatabase && (
          /* Stated plainly. The alternative is a filter that looks like a permission.
             The space above is explicit, not the span's old ml-1: margin is visual only, so
             a screen reader read "you are an owner.This filters what you see". */
          <span className="text-amber-ink">
            This filters what you see; it does not yet restrict what teammates can reach.
          </span>
        )}
      </p>
    </div>
  );
}
