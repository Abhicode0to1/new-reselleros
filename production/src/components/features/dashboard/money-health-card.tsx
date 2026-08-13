/**
 * Money-health banner — the loud half of the silent-failure problem.
 *
 * Renders NOTHING when everything is working, which is the point: this must
 * stay credible enough that its appearance means "stop and read". A permanent
 * status widget becomes furniture within a week and then a critical finding
 * looks exactly like the healthy state it replaced.
 *
 * It sits at the top of the dashboard rather than inside Settings because these
 * failures are invisible by nature. Nobody opens Settings to check whether
 * payments are being recorded — they open Settings after they already suspect
 * something, which is months too late.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { HealthFinding, HealthSeverity } from "@/lib/health/money-readiness";

interface HealthResponse {
  ok: boolean;
  findings: HealthFinding[];
  severity: HealthSeverity | null;
}

export function MoneyHealthCard() {
  const { data } = useQuery({
    queryKey: ["health", "money"],
    queryFn: async (): Promise<HealthResponse | null> => {
      const res = await fetch("/api/health/money");
      return res.ok ? res.json() : null;
    },
    // Config changes rarely, and a stale answer here is harmless — but a fix
    // should show up without a hard reload, so it revalidates on focus.
    staleTime: 60_000,
  });

  const findings = data?.findings ?? [];
  if (findings.length === 0) return null;

  const critical = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");
  const isCritical = critical.length > 0;

  return (
    <Card
      className={`mb-4 p-4 border ${
        isCritical ? "border-danger/40 bg-danger/5" : "border-amber/40 bg-amber/5"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            isCritical ? "bg-danger/10 text-danger" : "bg-amber/10 text-amber-ink"
          }`}
        >
          <Icon name="alert" size={16} />
        </div>

        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${isCritical ? "text-danger" : "text-amber-ink"}`}>
            {isCritical
              ? "Money is moving without being recorded"
              : "Getting paid could be easier"}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            {isCritical
              ? "These parts of the app look configured but are not doing anything."
              : "Nothing is broken — these would just speed up collection."}
          </p>

          <ul className="mt-3 space-y-3">
            {[...critical, ...warnings].map((f) => (
              <li key={f.id} className="border-l-2 border-hairline pl-3">
                <p className="text-sm font-medium text-ink">{f.title}</p>
                {/* The consequence, not the config key — a person can act on
                    "customers can pay and the app will never know". */}
                <p className="mt-0.5 text-xs text-ink-3">{f.consequence}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="text-xs font-medium text-ink-2">{f.fix}</p>
                  {f.href && (
                    <Button asChild variant="ghost" size="sm">
                      {/* Cast matches the rest of the app: hrefs come from data,
                          not from Next's statically-typed route union. */}
                      <Link href={f.href as never}>Open →</Link>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
