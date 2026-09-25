/**
 * PnlHeadline — the four numbers the P&L page exists to answer, first, in one row:
 * Revenue · Cost of goods (licence cost) · Expenses · Net profit.
 *
 * Every figure reads `model` (lib/accounting/pnl.ts), the basis-aware numbers. When the
 * cost of goods is not recorded, net profit is shown as UNKNOWN — with "revenue −
 * expenses" given only as a ceiling, labelled as such — never as a confident number
 * that quietly treats the licence cost as zero. The one note on the cost basis lives
 * here, once, instead of being repeated in every card below.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { rupee } from "@/lib/utils";
import { cogsBasisNote, type PnlPeriod } from "@/lib/accounting/pnl";

interface Props {
  model: PnlPeriod;
  revenueCount: number;
  expensesCount: number;
  onOpen: (kind: "revenue" | "cogs" | "expenses") => void;
}

function Tile({
  label, value, sub, tone = "ink", onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone?: "ink" | "emerald" | "rose" | "amber" | "muted";
  onClick?: () => void;
}) {
  const color = {
    ink: "text-ink", emerald: "text-emerald", rose: "text-rose", amber: "text-amber-ink", muted: "text-ink-3",
  }[tone];
  const body = (
    <>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={`font-serif text-2xl md:text-[28px] leading-tight mt-1 tabular-nums ${color}`}>{value}</div>
      <div className="text-2xs text-ink-3 mt-0.5 leading-snug">{sub}</div>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-md p-3 hover:bg-paper-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
    >
      {body}
    </button>
  ) : (
    <div className="p-3">{body}</div>
  );
}

export function PnlHeadline({ model, revenueCount, expensesCount, onOpen }: Props) {
  const pctOfRevenue = (v: number) => (model.revenue > 0 ? Math.round((v / model.revenue) * 100) : null);
  const net = model.netProfit;
  const netPct = net === null ? null : pctOfRevenue(net);

  return (
    <Card className="mb-6 p-2 md:p-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-1">
        <Tile
          label="Revenue"
          value={rupee(model.revenue)}
          sub={`${revenueCount} invoice${revenueCount === 1 ? "" : "s"} · before GST`}
          onClick={() => onOpen("revenue")}
        />
        <Tile
          label="Cost of goods (licence cost)"
          value={model.cogsBasis === "unknown" ? "Not recorded" : `− ${rupee(model.cogs)}`}
          tone={model.cogsBasis === "unknown" ? "amber" : "rose"}
          sub={model.cogsBasis === "unknown"
            ? "enter vendor bills to see margin"
            : model.cogsBasis === "estimated"
              ? `estimated${model.grossMarginPct !== null ? ` · gross margin ${model.grossMarginPct}%` : ""}`
              : `from vendor bills${model.grossMarginPct !== null ? ` · gross margin ${model.grossMarginPct}%` : ""}`}
          onClick={() => onOpen("cogs")}
        />
        <Tile
          label="Expenses"
          value={`− ${rupee(model.expenses)}`}
          tone="rose"
          sub={`${expensesCount} ${expensesCount === 1 ? "entry" : "entries"} · salaries, software, office…`}
          onClick={() => onOpen("expenses")}
        />
        <Tile
          label={net !== null && net < 0 ? "Net loss" : "Net profit"}
          value={net === null ? "Unknown" : rupee(Math.abs(net))}
          tone={net === null ? "muted" : net >= 0 ? "emerald" : "rose"}
          sub={net === null
            ? <>cost of goods missing · at most {rupee(model.revenue - model.expenses)} (revenue − expenses)</>
            : netPct === null ? "no revenue this period" : `${netPct}% of revenue`}
        />
      </div>

      {/* The cost-of-goods caveat, said once for the whole page. */}
      {model.cogsBasis !== "billed" && (
        <p className="mx-3 mb-1 mt-1 border-t border-hairline pt-2 text-2xs leading-snug text-amber-ink">
          {cogsBasisNote(model)}
        </p>
      )}
    </Card>
  );
}
