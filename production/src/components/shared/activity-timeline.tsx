/**
 * ActivityTimeline — vertical timeline for audit log, customer activity, lead history.
 *
 * @example
 * <ActivityTimeline events={[
 *   { icon: "phone", kind: "indigo", title: "Call with Rajesh", body: "Outcome: positive",
 *     time: "Today · 11:30 AM", actor: "Rahul B" },
 *   { icon: "rupee", kind: "emerald", title: "Payment received · ₹3.05L",
 *     time: "Today · 09:42 AM" },
 * ]} />
 */
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type TimelineKind = "indigo" | "amber" | "emerald" | "rose" | "slate";

export interface TimelineEvent {
  icon?: string;
  kind?: TimelineKind;
  title: React.ReactNode;
  body?: React.ReactNode;
  time?: string;
  actor?: string;
  meta?: string;
}

interface ActivityTimelineProps {
  events: TimelineEvent[];
  compact?: boolean;
  className?: string;
}

export function ActivityTimeline({ events, compact = false, className }: ActivityTimelineProps) {
  if (events.length === 0) return null;

  return (
    <div className={cn("relative pl-7", className)}>
      {/* Vertical line */}
      <div
        className="absolute left-3 top-2 bottom-2 w-px bg-hairline"
        aria-hidden="true"
      />

      {events.map((ev, i) => {
        const kind = ev.kind ?? "indigo";
        return (
          <div key={i} className={cn("relative", compact ? "pb-3" : "pb-5", i === events.length - 1 && "pb-0")}>
            {/* Dot */}
            <div
              className={cn(
                "absolute -left-7 top-0.5 w-6 h-6 rounded-full",
                "grid place-items-center ring-2 ring-paper",
                kind === "indigo" && "bg-indigo-soft text-indigo",
                kind === "amber" && "bg-amber-soft text-amber-ink",
                kind === "emerald" && "bg-emerald-soft text-emerald",
                kind === "rose" && "bg-rose-soft text-rose-ink",
                kind === "slate" && "bg-slate-soft text-slate"
              )}
            >
              <Icon name={ev.icon ?? "dot"} size={11} />
            </div>

            {/* Content */}
            <div>
              <div className={cn("font-medium text-ink leading-tight", compact ? "text-xs" : "text-sm")}>
                {ev.title}
              </div>
              {ev.body && (
                <div className={cn("text-ink-2 leading-relaxed mt-0.5", compact ? "text-xs" : "text-sm")}>
                  {ev.body}
                </div>
              )}
              {(ev.time || ev.actor || ev.meta) && (
                <div className="text-2xs text-ink-3 mt-1 flex flex-wrap gap-x-2">
                  {ev.time && <span>{ev.time}</span>}
                  {ev.actor && (
                    <>
                      <span>·</span>
                      <span>by {ev.actor}</span>
                    </>
                  )}
                  {ev.meta && (
                    <>
                      <span>·</span>
                      <span>{ev.meta}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
