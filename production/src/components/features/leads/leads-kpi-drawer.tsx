"use client";
/**
 * The numbers behind "More → Show the numbers" on Sales & Pipeline — moved verbatim out of
 * (app)/leads/page.tsx (S35, 28 Sep 2026). The page decides WHEN it shows.
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";

export interface LeadsKpiDrawerProps {
  leads: Lead[];
  totalValue: number;
  pipelineByType: { subscription: number; project: number };
  openDeals: Lead[];
  wonCount: number;
  decidedCount: number;
  conversion: number | null;
}

export function LeadsKpiDrawer({ leads, totalValue, pipelineByType, openDeals, wonCount, decidedCount, conversion }: LeadsKpiDrawerProps) {
  return (
    <div className="mb-2.5 p-2.5 border border-hairline rounded-lg bg-paper shrink-0">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Open Pipeline</p>
          <p className="font-serif text-base font-bold text-amber-ink tabular-nums mt-0.5">{rupee(totalValue, { compact: true })}</p>
          {/* Licences and custom software are different businesses — a ₹5L project and
              ₹5L of annual seats are not the same pipeline, so the split is shown. */}
          {pipelineByType.project > 0 && (
            <p className="text-xs text-ink-3 tabular-nums mt-0.5">
              Subscription {rupee(pipelineByType.subscription, { compact: true })} · Project {rupee(pipelineByType.project, { compact: true })}
            </p>
          )}
        </div>
        <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Open deals</p>
          <p className="font-serif text-base font-bold text-ink tabular-nums mt-0.5">{openDeals.length}</p>
        </div>
        <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Won</p>
          <p className="font-serif text-base font-bold text-ink tabular-nums mt-0.5">{wonCount}</p>
        </div>
        <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Win Rate</p>
          <p className="font-serif text-base font-bold text-emerald tabular-nums mt-0.5">
            {conversion === null ? "—" : `${conversion}%`}
          </p>
          {/* The sample, under the number. "100%" off two closed deals and "100%" off
              two hundred are the same three characters and not the same claim. */}
          <p className="text-xs text-ink-3 tabular-nums">
            {decidedCount > 0 ? `${wonCount} of ${decidedCount} decided` : "nothing closed yet"}
          </p>
        </div>
        <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">High Priority</p>
          <p className="font-serif text-base font-bold text-rose-600 tabular-nums mt-0.5">{leads.filter((l) => l.priority === "high").length}</p>
        </div>
        <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
          <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Total Inquiries</p>
          <p className="font-serif text-base font-bold text-ink tabular-nums mt-0.5">{leads.length}</p>
        </div>
      </div>
    </div>
  );
}
