/**
 * What the AI actually did — for the person deciding whether to trust it more.
 *
 * ─── EVERY NUMBER HERE CARRIES WHAT IT IS MADE OF ───────────────────────────
 * This panel is read by a founder deciding whether to open a dial, and the whole risk of an
 * "AI performance" dashboard is that it flatters the thing it measures. So:
 *
 *   · A rate is never shown without its numerator and denominator beside it.
 *   · A rupee figure is never shown without how many messages actually reached a customer.
 *   · "Touched", never "generated" — the AI drafts, a person reviews, the customer decides,
 *     and attributing the money to any one of the three is a choice, not a measurement.
 *   · A metric with no data says what is missing, not "0".
 *
 * The last of those is why the funnel is the headline rather than a conversion tile. Measured on
 * the live log 25 Aug 2026: 34 AI actions ever, and NOT ONE with outcome `sent`. A "0%
 * conversion" tile would send somebody to look at prompts; the actual fix is a dial or a
 * verified sending domain, and `topBlock` says which in the log's own words.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import type { AiPerformance } from "@/lib/ai/performance.server";

interface Props {
  data: AiPerformance;
  /** How many days the figures cover, so the panel can say so rather than imply "ever". */
  windowDays: number;
}

/** A number and what it is made of. The subtitle is not optional — see the file header. */
function Metric({
  label,
  value,
  detail,
  muted,
}: {
  label: string;
  value: string;
  detail: string;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{label}</p>
      <p
        className={`mt-1 font-serif text-2xl leading-none ${muted ? "text-ink-3" : "text-ink"}`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-xs leading-snug text-ink-3">{detail}</p>
    </div>
  );
}

export function AiPerformancePanel({ data, windowDays }: Props) {
  const { funnel, conversion, revenue, objections } = data;

  if (data.unavailable) {
    /* §24: what happened, and what it is not. "Could not read" must not look like "zero", which
       is the one reading that would be actively misleading here. */
    return (
      <Card className="p-4">
        <p className="text-sm font-semibold text-ink">AI activity</p>
        <p className="mt-1 text-xs text-ink-3">
          Could not read the AI activity log just now. This is not the same as no activity —
          try again in a moment.
        </p>
      </Card>
    );
  }

  if (funnel.drafted === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm font-semibold text-ink">AI activity</p>
        <p className="mt-1 text-xs text-ink-3">
          The AI has not handled anything in the last {windowDays} days. Once an enquiry arrives
          by email or WhatsApp, what it drafted and what it sent will show up here.
        </p>
      </Card>
    );
  }

  const blocked = funnel.held + funnel.failed;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">What the AI did</p>
          <p className="mt-0.5 text-xs text-ink-3">Last {windowDays} days</p>
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber/10 text-amber-ink">
          <Icon name="sparkles" className="h-4 w-4" />
        </div>
      </div>

      {/* The funnel first, because while `sent` is zero it is the only tile with information. */}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric
          label="Drafted"
          value={String(funnel.drafted)}
          detail={`${funnel.drafted === 1 ? "message" : "messages"} the AI prepared`}
        />
        <Metric
          label="Sent"
          value={String(funnel.sent)}
          muted={funnel.sent === 0}
          detail={
            funnel.sent === 0
              ? "nothing has reached a customer yet"
              : `reached a customer`
          }
        />
        <Metric
          label="Held or failed"
          value={String(blocked)}
          detail={
            funnel.failed > 0
              ? `${funnel.held} held, ${funnel.failed} could not be drafted`
              : "waiting for a person"
          }
        />
        <Metric
          label="Switched off"
          value={String(funnel.skipped)}
          muted
          detail="a deliberate no, not a problem"
        />
      </div>

      {funnel.topBlock ? (
        <div className="mt-4 rounded-lg border border-hairline bg-paper-2 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
            What is in the way most often
          </p>
          {/* The log's own sentence, not a category. logAiAction writes these for a
              non-technical reader (§24), and re-labelling them would replace a sentence somebody
              can act on with one they cannot. */}
          <p className="mt-1 text-sm leading-snug text-ink">{funnel.topBlock.reason}</p>
          <p className="mt-1 text-xs text-ink-3">
            {funnel.topBlock.count} of {blocked}
            {blocked === 1 ? " time" : " times"} ·{" "}
            {/* `/automation`, not `/settings/automation` — the first guess was wrong and
                typedRoutes caught it at typecheck rather than at runtime, which is the whole
                reason `npm run build` is in this repo's definition of green (CLAUDE.md §25.2). */}
            <Link href="/automation" className="font-medium text-amber-ink underline">
              Review the automation dials
            </Link>
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-hairline pt-4 sm:grid-cols-2">
        <Metric
          label="Conversion"
          value={conversion.rate === null ? "—" : `${Math.round(conversion.rate * 100)}%`}
          muted={conversion.rate === null}
          detail={
            conversion.rate === null
              ? conversion.unavailable
              : `${conversion.converted} paid of ${conversion.reached} leads the AI wrote to`
          }
        />
        {/* TOUCHED, never "generated". The send count travels with the figure so it cannot be
            read as the AI having earned it — see lib/ai/performance.ts. */}
        <Metric
          label="Revenue on deals it touched"
          value={revenue.touchedRupees === null ? "—" : rupee(revenue.touchedRupees)}
          muted={revenue.touchedRupees === null}
          detail={
            revenue.touchedRupees === null
              ? revenue.unavailable
              : `received on deals where ${revenue.sentCount} AI ${
                  revenue.sentCount === 1 ? "message" : "messages"
                } reached the customer — association, not credit`
          }
        />
      </div>

      <div className="mt-4 border-t border-hairline pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
          What customers push back on
        </p>
        {objections.unavailable ? (
          <p className="mt-1 text-xs leading-snug text-ink-3">{objections.unavailable}</p>
        ) : objections.top.length === 0 ? (
          <p className="mt-1 text-xs leading-snug text-ink-3">
            Nobody has raised a recognised objection in {objections.messagesRead} messages.
          </p>
        ) : (
          <>
            <ul className="mt-2 space-y-1.5">
              {objections.top.slice(0, 4).map((o) => (
                <li key={o.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-ink">{o.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-3">
                    {o.count} · {Math.round(o.share * 100)}%
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-3">
              from {objections.messagesWithObjection} of {objections.messagesRead} customer
              messages · one message can raise two
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The fetching shell. Split from the panel above ONLY so the panel can be tested with fixtures.
 *
 * Same shape as MoneyHealthCard: it calls its own endpoint rather than taking server data as a
 * prop, because the dashboard page is a client component and cannot await a server loader.
 *
 * Renders nothing at all while loading, and nothing for a non-owner (the route answers
 * `performance: null`). A skeleton here would put a permanent grey box on the dashboard for
 * every non-owner, which is furniture — the same argument money-health-card.tsx makes for
 * rendering nothing when healthy.
 */
export function AiPerformanceCard() {
  const { data } = useQuery({
    queryKey: ["ai", "performance"],
    queryFn: async (): Promise<{ performance: AiPerformance | null; windowDays: number } | null> => {
      const res = await fetch("/api/ai/performance");
      return res.ok ? res.json() : null;
    },
    /* A minute. The figures move when a dial is turned or a mail goes out, and a founder who
       just changed a setting should see it without a hard reload. */
    staleTime: 60_000,
  });

  if (!data?.performance) return null;
  return <AiPerformancePanel data={data.performance} windowDays={data.windowDays} />;
}
