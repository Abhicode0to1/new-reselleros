"use client";

/**
 * The Draft → Sent → Signed → Paid → Provisioned → Invoiced bar.
 *
 * A progress bar is the most believable thing on a screen: six ticks and people stop
 * asking questions. So the visual vocabulary here has FOUR states, not two, because
 * "done" and "not done" cannot express the case that actually matters — a step that
 * legitimately does not apply.
 *
 *   done     a filled tick — this happened
 *   current  a ring — this is what the quote is waiting on
 *   todo     hollow — not yet
 *   skipped  a dash — nothing to do here, and NOT a tick
 *
 * The dash is the point. A services-only quote has nothing to provision; showing that
 * as a green tick would claim work happened that nobody did.
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { LifecycleStep } from "@/lib/quotes/lifecycle";

export function LifecycleStepper({ steps, dead }: { steps: LifecycleStep[]; dead?: boolean }) {
  return (
    <ol
      className={cn("flex w-full items-start gap-1 overflow-x-auto", dead && "opacity-60")}
      aria-label="Quote progress"
    >
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <li key={step.stage} className="flex min-w-0 flex-1 items-start gap-1">
            <div className="flex min-w-0 flex-1 flex-col items-center text-center">
              <div className="flex w-full items-center">
                {/* Left connector — hidden on the first step so the row starts clean. */}
                <span className={cn("h-px flex-1", i === 0 ? "opacity-0" : connector(steps[i - 1]))} />
                <span
                  title={step.detail}
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 text-[11px] font-bold",
                    step.state === "done"    && "border-emerald bg-emerald text-white",
                    step.state === "current" && "border-amber bg-paper text-amber-ink",
                    step.state === "todo"    && "border-hairline-strong bg-paper text-ink-3",
                    step.state === "skipped" && "border-dashed border-hairline-strong bg-paper text-ink-3",
                  )}
                >
                  {step.state === "done" ? <Icon name="check" size={12} />
                    : step.state === "skipped" ? "–"
                    : i + 1}
                </span>
                <span className={cn("h-px flex-1", isLast ? "opacity-0" : connector(step))} />
              </div>
              <span
                className={cn(
                  "mt-1 truncate text-[10px] font-semibold uppercase tracking-wider",
                  step.state === "done"    && "text-emerald",
                  step.state === "current" && "text-amber-ink",
                  step.state === "todo"    && "text-ink-3",
                  step.state === "skipped" && "text-ink-3",
                )}
              >
                {step.label}
              </span>
              {/* The detail is on screen for the current and failed steps rather than
                  hidden in a tooltip — a phone has no hover, and this is the one step
                  somebody actually needs to read. */}
              {step.state === "current" && (
                <span className="mt-0.5 hidden text-[10px] leading-snug text-ink-3 sm:block">
                  {step.detail}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function connector(prev: LifecycleStep): string {
  return prev.state === "done" ? "bg-emerald" : "bg-hairline-strong";
}
