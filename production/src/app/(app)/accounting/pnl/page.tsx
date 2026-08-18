/**
 * P&L Report — Profit & Loss for the selected period.
 *
 *   Revenue          (from paid + outstanding invoices, accrual basis)
 * − COGS             (from vendor_bills with category='COGS-*')
 * = Gross Margin
 * − Operating Expenses (from expenses table)
 * = Net Profit
 *
 * Also shows the GST snapshot for the same period:
 *   Output GST collected  (CGST + SGST + IGST on invoices)
 * − Input GST paid        (on vendor bills + expenses with GST)
 * = Net GST liability
 *
 * Default range = current fiscal year (April 1 → today). Common quick-picks
 * (this month / quarter / FY) plus custom range.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Term } from "@/components/shared/term";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { createClient } from "@/lib/supabase/client";
import { PnLDrilldownDialog, type PnLDrillKind } from "@/components/features/accounting/pnl-drilldown-dialog";
import { PnlWaterfall } from "@/components/features/accounting/pnl-waterfall";
import {
  buildPnl, vendorsFromSubscriptions, cogsBasisNote, compareFigures, isPartialPeriod,
  type PnlPeriod,
} from "@/lib/accounting/pnl";
import { pnlWaterfall } from "@/lib/accounting/waterfall";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ────────────────────────────────────────────────────────────────
// Range helpers — all IST-safe (Indian FY runs Apr 1 → Mar 31)
// ────────────────────────────────────────────────────────────────

function istToday(): Date {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Indian fiscal year start (Apr 1) of the FY containing `d`. */
function fiscalYearStart(d: Date): Date {
  const yr = d.getUTCFullYear();
  const m  = d.getUTCMonth();
  // Months before April → previous calendar year's FY
  const fyYear = m < 3 ? yr - 1 : yr;
  return new Date(Date.UTC(fyYear, 3, 1)); // April 1
}

interface DateRange { from: string; to: string }

// Presets span the FULL calendar period (1st → last day) to match the GST and
// Expenses reports exactly — so the same month/quarter/FY reconciles across pages.
// (Future days carry no transactions, so month-to-date totals are unchanged.)
function thisMonth(): DateRange {
  const t = istToday();
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const last  = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
  return { from: yyyymmdd(first), to: yyyymmdd(last) };
}

function thisQuarter(): DateRange {
  const t = istToday();
  const qStart = Math.floor(t.getUTCMonth() / 3) * 3;
  const first = new Date(Date.UTC(t.getUTCFullYear(), qStart, 1));
  const last  = new Date(Date.UTC(t.getUTCFullYear(), qStart + 3, 0));
  return { from: yyyymmdd(first), to: yyyymmdd(last) };
}

function thisFY(): DateRange {
  const t = istToday();
  const fy = fiscalYearStart(t);
  const last = new Date(Date.UTC(fy.getUTCFullYear() + 1, 3, 0));   // 31 Mar next year
  return { from: yyyymmdd(fy), to: yyyymmdd(last) };
}

const QUICK_RANGES: { label: string; build: () => DateRange }[] = [
  { label: "This month",   build: thisMonth   },
  { label: "This quarter", build: thisQuarter },
  { label: "This FY",      build: thisFY      },
];

// ────────────────────────────────────────────────────────────────
// P&L aggregation hook
// ────────────────────────────────────────────────────────────────

interface PnLNumbers {
  revenue:        number;   // Invoices ≥ status='pending' within period
  revenueCount:   number;
  cogs:           number;   // Vendor bills category 'COGS-*' within period
  cogsCount:      number;
  grossMargin:    number;
  expenses:       number;
  expensesCount:  number;
  expensesByCategory: { category: string; total: number; count: number }[];
  commissions:      number;   // referral / channel-partner commissions (gross)
  commissionsCount: number;
  netProfit:      number;

  // GST snapshot
  outputGST: number;        // 18% of invoice subtotal proxy (using net_payable for simplicity)
  inputGST:  number;        // CGST + SGST + IGST on bills + gst_paid on expenses
  netGST:    number;

  // For quick scan
  marginPct: number;        // gross margin / revenue
  profitPct: number;        // net profit / revenue

  /**
   * The figures that know their own basis — lib/accounting/pnl.ts.
   *
   * Kept ALONGSIDE the flat fields above rather than replacing them: the GST snapshot,
   * the CSV export and the drill-down all read those, and swapping them wholesale would
   * be a large diff to change one number. Where the two disagree — and on this tenant
   * they do, because `cogs` reads an empty table — **`model` is the one to trust.**
   */
  model: PnlPeriod;
}

function usePnL(range: DateRange, enabled = true) {
  return useQuery({
    queryKey: ["accounting", "pnl", range],
    /* The comparison period is fetched only once the owner asks for it. A second full
       aggregation on every page load, for a number nobody is reading, is a cost with no
       reader. */
    enabled,
    queryFn: async (): Promise<PnLNumbers> => {
      const supabase = createClient();

      // ── Revenue: invoices issued in the period (accrual basis) ────
      // We include all non-draft / non-void invoices because the legal
      // revenue recognition point is invoice issue, not payment receipt.
      const { data: invoices, error: invErr } = await supabase
        .from("invoices")
        .select("amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate")
        .gte("invoice_date", range.from)
        .lte("invoice_date", range.to)
        .in("status", ["pending", "paid", "overdue"]);
      if (invErr) throw invErr;

      // Revenue = the TAXABLE value, never the GST-inclusive amount — output GST
      // is money owed to the government, not income (migration 0116 persists it).
      // Fall back to reverse-deriving for any legacy row missing the breakdown.
      const invTaxable = (i: { amount: number | null; taxable_value: number | null; tax_rate: number | null }) =>
        i.taxable_value ?? Math.round((i.amount ?? 0) * 100 / (100 + (i.tax_rate ?? 18)));
      const invTax = (i: { amount: number | null; tax_amount: number | null; taxable_value: number | null; tax_rate: number | null }) =>
        i.tax_amount ?? ((i.amount ?? 0) - invTaxable(i));

      // Credit / debit notes net revenue + output GST for the period (a credit
      // note reduces recognised revenue, a debit note increases it).
      const [{ data: cnP }, { data: dnP }] = await Promise.all([
        supabase.from("credit_notes").select("taxable_value, tax_amount, credit_date").gte("credit_date", range.from).lte("credit_date", range.to),
        supabase.from("debit_notes").select("taxable_value, tax_amount, debit_date").gte("debit_date", range.from).lte("debit_date", range.to),
      ]);
      const cnTaxable = (cnP ?? []).reduce((s, n) => s + (n.taxable_value ?? 0), 0);
      const cnTax     = (cnP ?? []).reduce((s, n) => s + (n.tax_amount ?? 0), 0);
      const dnTaxable = (dnP ?? []).reduce((s, n) => s + (n.taxable_value ?? 0), 0);
      const dnTax     = (dnP ?? []).reduce((s, n) => s + (n.tax_amount ?? 0), 0);

      const revenue       = (invoices ?? []).reduce((s, i) => s + invTaxable(i), 0) - cnTaxable + dnTaxable;
      const revenueCount  = (invoices ?? []).length;
      const outputGST     = (invoices ?? []).reduce((s, i) => s + invTax(i), 0) - cnTax + dnTax;

      // ── COGS: vendor bills with category like 'COGS-%' ────────────
      const { data: bills, error: bErr } = await supabase
        .from("vendor_bills")
        .select("total, subtotal, cgst, sgst, igst, category")
        .gte("bill_date", range.from)
        .lte("bill_date", range.to)
        .like("category", "COGS-%");
      if (bErr) throw bErr;

      const cogs      = (bills ?? []).reduce((s, b) => s + (b.subtotal ?? 0), 0);  // Pre-GST cost
      const cogsCount = (bills ?? []).length;
      const billsGst  = (bills ?? []).reduce((s, b) => s + (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0), 0);

      // ── Expenses: non-COGS ─────────────────────────────────────────
      const { data: expenses, error: eErr } = await supabase
        .from("expenses")
        .select("amount, gst_paid, category")
        .gte("expense_date", range.from)
        .lte("expense_date", range.to);
      if (eErr) throw eErr;

      const expensesTotal = (expenses ?? []).reduce((s, e) => s + (e.amount ?? 0), 0);
      const expensesCount = (expenses ?? []).length;
      const expensesGst   = (expenses ?? []).reduce((s, e) => s + (e.gst_paid ?? 0), 0);

      // Break operating expenses down by category (Salaries, Rent, Software…),
      // biggest first — so you can see where the money went at a glance.
      const catAgg = (expenses ?? []).reduce<Record<string, { total: number; count: number }>>((m, e) => {
        const c = e.category || "Uncategorised";
        (m[c] ??= { total: 0, count: 0 }).total += e.amount ?? 0;
        m[c].count += 1;
        return m;
      }, {});
      const expensesByCategory = Object.entries(catAgg)
        .map(([category, v]) => ({ category, total: v.total, count: v.count }))
        .sort((a, b) => b.total - a.total);

      // ── Referral commissions earned in the period (operating expense) ──
      // The GROSS commission is the expense; TDS is only a withholding, not a
      // reduction. Cancelled accruals are excluded.
      const { data: comms } = await supabase
        .from("referral_commissions")
        .select("gross_commission, earned_date, status")
        .gte("earned_date", range.from)
        .lte("earned_date", range.to)
        .neq("status", "cancelled");
      const commissions      = (comms ?? []).reduce((s, c) => s + (c.gross_commission ?? 0), 0);
      const commissionsCount = (comms ?? []).length;

      /* ── THE SUBSCRIPTION BOOK — where the licence cost actually lives ──────
         `vendor_bills` is EMPTY on this tenant, so the COGS above is ₹0 and the report
         used to claim a 100% gross margin. A reseller buys licences and sells them.

         The cost was never missing from the app, only from that table: 9 Google
         subscriptions carry ₹70,340/month of wholesale against ₹1,08,552 of MRR — a 35%
         margin, and the number the owner needed. lib/accounting/pnl.ts prorates it by how
         long each subscription actually ran inside the window and labels the basis, so an
         estimate never renders as a fact. */
      const { data: subs, error: sErr } = await supabase
        .from("subscriptions")
        .select("vendor, seats, mrr, start_date, renewal_date, item_id, status")
        .neq("status", "cancelled");
      if (sErr) throw sErr;

      const itemIds = [...new Set((subs ?? []).map((s) => s.item_id).filter((id): id is string => !!id))];
      const { data: items } = itemIds.length
        ? await supabase.from("items").select("id, wholesale").in("id", itemIds)
        : { data: [] as { id: string; wholesale: number | null }[] };
      const wholesaleById = new Map((items ?? []).map((i) => [i.id, i.wholesale ?? 0]));

      const vendors = vendorsFromSubscriptions(
        (subs ?? []).map((s) => ({
          vendor: String(s.vendor ?? "other"),
          seats: s.seats ?? 0,
          mrr: s.mrr ?? 0,
          wholesalePerSeatMonth: s.item_id ? (wholesaleById.get(s.item_id) ?? 0) : 0,
          startDate: s.start_date,
          renewalDate: s.renewal_date,
        })),
        range.from, range.to,
      );

      /* Commissions are an operating cost, not a cost of goods — they are paid on a sale
         that already happened, so they sit below the gross margin exactly as netProfit
         has always treated them. */
      const model = buildPnl({
        revenue,
        expenses: expensesTotal + commissions,
        billedCogs: cogs > 0 ? cogs : null,
        vendors,
      });

      // ── Compute derived numbers ─────────────────────────────────────
      const grossMargin = revenue - cogs;
      const netProfit   = grossMargin - expensesTotal - commissions;
      const inputGST    = billsGst + expensesGst;
      const netGST      = outputGST - inputGST;

      const marginPct = revenue > 0 ? (grossMargin / revenue) * 100 : 0;
      const profitPct = revenue > 0 ? (netProfit / revenue) * 100   : 0;

      return {
        revenue, revenueCount,
        cogs, cogsCount,
        grossMargin,
        expenses: expensesTotal, expensesCount, expensesByCategory,
        commissions, commissionsCount,
        netProfit,
        outputGST, inputGST, netGST,
        marginPct, profitPct,
        model,
      };
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

/** The period immediately before this one, of the same length — for the comparison. */
function previousRange(r: DateRange): DateRange {
  const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const len = day(r.to) - day(r.from) + 86_400_000;
  return {
    from: yyyymmdd(new Date(day(r.from) - len)),
    to:   yyyymmdd(new Date(day(r.from) - 86_400_000)),
  };
}

export default function PnLPage() {
  const [range, setRange] = React.useState<DateRange>(thisMonth());
  const { data, isLoading } = usePnL(range);
  const [drill, setDrill] = React.useState<PnLDrillKind | null>(null);
  const [drillExpenseCat, setDrillExpenseCat] = React.useState<string | null>(null);

  /* ── Comparison ──────────────────────────────────────────────────────────
     Off by default. A second full aggregation on every page load, for a number the
     owner has not asked for yet, is a cost with no reader. */
  const [compare, setCompare] = React.useState(false);
  const prevRange = React.useMemo(() => previousRange(range), [range]);
  const { data: prev } = usePnL(prevRange, compare);

  const today = React.useMemo(() => yyyymmdd(istToday()), []);
  const partial = isPartialPeriod(range.to, today);

  const [vendorTab, setVendorTab] = React.useState<string | "all">("all");

  // Export the statement as a CSV the owner can hand to their CA (mirrors GST export).
  function exportCSV() {
    if (!data) return;
    downloadCSV(
      `pnl-${range.from}-to-${range.to}.csv`,
      ["Line", "Amount (INR)"],
      [
        ["Period", `${range.from} to ${range.to}`],
        ["Revenue", data.revenue],
        ["Cost of goods sold", -data.cogs],
        ["Gross margin", data.grossMargin],
        ["Operating expenses", -data.expenses],
        ["Commissions", -data.commissions],
        ["Net profit", data.netProfit],
        ["", ""],
        ["Output GST (on sales)", data.outputGST],
        ["Input GST (ITC)", data.inputGST],
        ["Net GST payable", data.netGST],
      ],
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">P&L Report</h1>
          <p className="text-sm text-ink-3 mt-1">
            Revenue minus cost of goods minus operating expenses = net profit.
            Accrual basis (invoice date, not payment date).
          </p>
        </div>
        <Button icon="download" onClick={exportCSV} disabled={isLoading || !data}>
          Export CSV
        </Button>
      </div>

      {/* Range picker */}
      <Card className="mb-6 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_RANGES.map((q) => {
              const target = q.build();
              const active = range.from === target.from && range.to === target.to;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => setRange(target)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    active
                      ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                      : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                  }`}
                >
                  {q.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">From</label>
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
            <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">To</label>
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
          </div>
        </div>
      </Card>

      {/* ── THE MONEY FLOW ───────────────────────────────────────────────────
          The chart the page always claimed to have: "P&L waterfall" was a comment over a
          list of rows. Bars are clickable into the same drill-down the rows use, so it is
          a way in rather than a picture. */}
      {!isLoading && data && (() => {
        const m = data.model;
        const steps = pnlWaterfall(m);
        return (
          <Card className="p-4 md:p-5 mb-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h2 className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
                Where the money went
              </h2>
              <div className="flex items-center gap-2">
                {m.cogsBasis === "estimated" && (
                  <Badge kind="warning" size="sm">Licence cost estimated</Badge>
                )}
                <button
                  type="button"
                  onClick={() => setCompare((c) => !c)}
                  className="text-[11px] font-semibold text-amber-ink hover:underline"
                >
                  {compare ? "Hide comparison" : "Compare with previous period"}
                </button>
              </div>
            </div>

            {steps ? (
              <PnlWaterfall
                steps={steps}
                onSelect={(key) => {
                  if (key === "revenue") setDrill("revenue");
                  else if (key === "cogs") setDrill("cogs");
                  else if (key === "opex") { setDrillExpenseCat(null); setDrill("expenses"); }
                }}
              />
            ) : (
              /* The chart REFUSES to draw when the cost of goods is unknown. A waterfall's
                 shape asserts that every step is known — drawing one over a missing COGS
                 would be the same confident lie the ₹0 told, only prettier. §24: say what
                 is wrong and where to fix it. */
              <div className="rounded-md border border-amber/40 bg-amber-soft/30 px-3 py-2.5">
                <p className="text-[12px] font-medium text-ink">
                  Can&apos;t chart this period — the licence cost is missing.
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-2">{cogsBasisNote(m)}</p>
              </div>
            )}

            <p className="mt-3 border-t border-hairline pt-2 text-[11px] leading-snug text-ink-3">
              {cogsBasisNote(m)}
            </p>

            {/* Comparison — deltas that refuse to lie. See compareFigures. */}
            {compare && (
              <div className="mt-3 grid grid-cols-1 gap-2 border-t border-hairline pt-3 sm:grid-cols-3">
                {([
                  ["Revenue", m.revenue, prev?.model.revenue ?? null],
                  ["Gross margin", m.grossMargin, prev?.model.grossMargin ?? null],
                  ["Net profit", m.netProfit, prev?.model.netProfit ?? null],
                ] as const).map(([label, cur, was]) => (
                  <ComparisonCell
                    key={label}
                    label={label}
                    current={cur}
                    previous={was}
                    partial={partial}
                    loading={!prev}
                    periodLabel={`${prevRange.from} to ${prevRange.to}`}
                  />
                ))}
              </div>
            )}
          </Card>
        );
      })()}

      {/* ── PROFIT BY VENDOR ─────────────────────────────────────────────────
          Both sides come from the SAME subscription rows, so each vendor's margin is
          internally coherent. Only vendors that actually have subscriptions get a tab —
          a Microsoft tab reading ₹0 would look like a business failing at Microsoft
          rather than one not selling it. */}
      {!isLoading && data && data.model.byVendor.length > 0 && (
        <Card className="p-4 md:p-5 mb-6">
          <h2 className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-3">
            Profit by vendor · from your subscription book
          </h2>

          <div className="mb-3 flex flex-wrap items-center gap-1">
            {(["all", ...data.model.byVendor.map((v) => v.vendor)] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVendorTab(v)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                  vendorTab === v
                    ? "bg-ink text-paper"
                    : "text-ink-2 hover:bg-paper-2",
                )}
              >
                {v === "all" ? "All" : data.model.byVendor.find((x) => x.vendor === v)!.label}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {data.model.byVendor
              .filter((v) => vendorTab === "all" || v.vendor === vendorTab)
              .map((v) => (
                <div key={v.vendor} className="rounded-md border border-hairline p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">{v.label}</span>
                    <span className="text-[11px] text-ink-3 tabular-nums">
                      {v.subscriptions} subscription{v.subscriptions === 1 ? "" : "s"} · {v.seats} seats
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Figure label="Revenue" value={v.revenue} tone="amber" />
                    <Figure label="Licence cost" value={v.cost} tone="rose" />
                    <Figure label="Gross" value={v.gross} tone={v.gross >= 0 ? "emerald" : "rose"} />
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Margin</div>
                      <div className={cn(
                        "font-serif text-lg leading-none tabular-nums",
                        v.marginPct === null ? "text-ink-3" : v.marginPct >= 25 ? "text-emerald" : "text-amber-ink",
                      )}>
                        {/* An em dash, never "0%" and never "100%" — see vendorLine. */}
                        {v.marginPct === null ? "—" : `${v.marginPct}%`}
                      </div>
                    </div>
                  </div>
                  {v.marginNote && (
                    <p className="mt-1.5 text-[11px] leading-snug text-amber-ink">{v.marginNote}</p>
                  )}
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* P&L waterfall */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 mb-6">
        {/* Left: waterfall */}
        <Card className="p-5 md:p-6">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-4">
            For period · {range.from} to {range.to}
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : data ? (
            <div className="space-y-2.5">
              {/* These rows read `model`, not the flat fields. The flat `cogs` comes from
                  `vendor_bills`, which is empty here — it is what printed "₹0 · 100.0%
                  margin" directly under a chart saying 37%. One page cannot hold two
                  answers to the same question. */}
              <Row label="Revenue"        amount={data.model.revenue}     hint={`${data.revenueCount} invoice${data.revenueCount === 1 ? "" : "s"}`} onHint={() => setDrill("revenue")} tone="ink" />
              <Row label={<>− <Term k="cogs">COGS</Term></>}
                   amount={-data.model.cogs}
                   hint={data.model.cogsBasis === "estimated"
                     ? "estimated from your wholesale rates"
                     : `${data.cogsCount} vendor bill${data.cogsCount === 1 ? "" : "s"}`}
                   onHint={() => setDrill("cogs")}
                   tone="rose" />

              <Divider />
              <Row label={<Term k="gross_margin">Gross Margin</Term>}
                   amount={data.model.grossMargin ?? 0}
                   hint={data.model.grossMarginPct === null
                     ? "margin unknown — no licence cost recorded"
                     : `${data.model.grossMarginPct}% margin`}
                   tone={(data.model.grossMargin ?? 0) >= 0 ? "emerald" : "rose"}
                   emphasis />

              <Row label={<>− <Term k="opex">Operating expenses</Term></>}
                   amount={-data.expenses}
                   hint={`${data.expensesCount} ${data.expensesCount === 1 ? "entry" : "entries"}`}
                   onHint={() => { setDrillExpenseCat(null); setDrill("expenses"); }}
                   tone="rose" />

              {/* Category breakdown — click a group to see its entries. */}
              {data.expensesByCategory.length > 0 && (
                <div className="mt-1 mb-1 space-y-0.5">
                  {data.expensesByCategory.map((c) => (
                    <button
                      key={c.category}
                      type="button"
                      onClick={() => { setDrillExpenseCat(c.category); setDrill("expenses"); }}
                      title={`See ${c.category} entries`}
                      className="w-full flex items-center justify-between gap-3 rounded pl-6 pr-1 py-1 text-left transition-colors hover:bg-paper-2/60"
                    >
                      <span className="text-[13px] text-ink-2">
                        {c.category} <span className="text-[11px] text-ink-3">· {c.count}</span>
                      </span>
                      <span className="font-mono text-[13px] tabular-nums text-rose">-{rupee(c.total)}</span>
                    </button>
                  ))}
                </div>
              )}

              {data.commissions > 0 && (
                <Row label="− Referral commissions"
                     amount={-data.commissions}
                     hint={`${data.commissionsCount} ${data.commissionsCount === 1 ? "payout" : "payouts"}`}
                     tone="rose" />
              )}

              <Divider thick />
              <Row label="Net Profit"
                   amount={data.netProfit}
                   hint={`${data.profitPct.toFixed(1)}% net margin`}
                   tone={data.netProfit >= 0 ? "emerald" : "rose"}
                   emphasis
                   xl />
            </div>
          ) : null}
        </Card>

        {/* Right: GST snapshot */}
        <Card className="p-5 md:p-6">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-4">
            GST snapshot (same period)
          </div>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : data ? (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3"><Term k="output_gst">Output GST</Term> (on sales)</span>
                <span className="font-mono text-ink font-semibold">{rupee(data.outputGST)}</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3">− <Term k="input_gst">Input GST</Term> paid</span>
                <span className="font-mono text-emerald">−{rupee(data.inputGST)}</span>
              </div>
              <div className="border-t-2 border-ink pt-3 flex justify-between items-baseline">
                <span className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold"><Term k="net_liability">Net liability</Term></span>
                <span className={`font-serif text-2xl ${data.netGST >= 0 ? "text-rose" : "text-emerald"}`}>
                  {rupee(data.netGST)}
                </span>
              </div>
              <p className="text-[11px] text-ink-3 leading-relaxed mt-3">
                Net positive = payable to govt. Negative = refund / carryforward credit.
                File via GSTR-3B by the 20th of next month.
              </p>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Quick insights */}
      {data && data.revenue > 0 && (
        <Card className="p-5 bg-paper-2/30">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
            What this means
          </div>
          <ul className="text-sm text-ink-2 space-y-1.5 list-disc pl-5">
            {/* Every line reads `model`. These used to run off the flat fields, so the
                page could congratulate the owner on a 100% margin in the same breath as
                telling them no COGS was recorded — two conclusions from one gap. */}
            {data.model.netProfit === null ? (
              <li className="text-amber-ink">
                Net profit can&apos;t be stated for this period — no licence cost is recorded, and
                a licence you buy and resell is never 100% profit.
              </li>
            ) : data.model.netProfit >= 0 ? (
              <li>
                Aapne is period mein <b className="text-emerald">{rupee(data.model.netProfit)}</b> net
                profit kamaya
                {data.model.revenue > 0 && ` — ${Math.round((data.model.netProfit / data.model.revenue) * 100)}% margin`}.
              </li>
            ) : (
              <li className="text-rose">
                Is period mein <b>{rupee(Math.abs(data.model.netProfit))} ka loss</b> hai. Licence cost ya
                running costs zyada hain.
              </li>
            )}
            {data.model.grossMarginPct !== null && data.model.grossMarginPct < 20 && data.model.revenue > 0 && (
              <li className="text-amber-ink">Gross margin is only {data.model.grossMarginPct}% — a healthy reseller range is 25–35%. Check your vendor bills or review your pricing.</li>
            )}
            {data.model.cogsBasis === "estimated" && (
              <li className="text-amber-ink">
                The licence cost above is estimated from your own wholesale rates — no vendor bills
                are recorded. Enter the Google CSP / Microsoft / Zoho invoices to make this exact.
              </li>
            )}
          </ul>
        </Card>
      )}

      <PnLDrilldownDialog
        open={drill !== null}
        onOpenChange={(o) => { if (!o) { setDrill(null); setDrillExpenseCat(null); } }}
        kind={drill}
        range={range}
        expenseCategory={drillExpenseCat}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// P&L row primitives
// ────────────────────────────────────────────────────────────────

function Row({
  label, amount, hint, onHint, tone, emphasis, xl,
}: {
  label: React.ReactNode;
  amount: number;
  hint?: string;
  /** When set, the hint becomes a button that opens the drill-down popup. */
  onHint?: () => void;
  tone: "ink" | "emerald" | "rose";
  emphasis?: boolean;
  xl?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : "text-ink";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className={`${emphasis ? "font-semibold" : ""} ${xl ? "text-base" : "text-sm"} text-ink leading-tight`}>
          {label}
        </div>
        {hint && (
          onHint
            ? <button type="button" onClick={onHint} className="text-[11px] text-amber-ink hover:underline mt-0.5 inline-flex items-center gap-0.5">{hint} <span aria-hidden>→</span></button>
            : <div className="text-[11px] text-ink-3 mt-0.5">{hint}</div>
        )}
      </div>
      <div className={`font-mono whitespace-nowrap ${xl ? "font-serif text-3xl" : emphasis ? "text-lg font-semibold" : "text-base"} ${colorClass}`}>
        {amount < 0 ? "−" : ""}{rupee(Math.abs(amount))}
      </div>
    </div>
  );
}

function Divider({ thick = false }: { thick?: boolean }) {
  return <div className={`my-2 border-t ${thick ? "border-ink-2 border-t-2" : "border-hairline"}`} />;
}

/** One figure in the vendor card. Colour by direction, not by size. */
function Figure({ label, value, tone }: {
  label: string; value: number; tone: "amber" | "rose" | "emerald";
}) {
  const cls = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : "text-amber-ink";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("font-serif text-lg leading-none tabular-nums", cls)}>{rupee(value)}</div>
    </div>
  );
}

/**
 * One period-over-period cell.
 *
 * ─── THE BADGE REFUSES TO LIE ───────────────────────────────────────────────
 * Growth from ₹0 is "new", not +100%. A drop to ₹0 is "nothing this period", not −100%.
 * And a period that is STILL RUNNING is not compared at all: 18 days of this month
 * against all 31 of last month shows a fall that has not happened, and a red badge there
 * is simply wrong. compareFigures() makes those calls; this only paints them.
 */
function ComparisonCell({ label, current, previous, partial, loading, periodLabel }: {
  label: string;
  current: number | null;
  previous: number | null;
  partial: boolean;
  loading: boolean;
  periodLabel: string;
}) {
  if (loading) return <Skeleton className="h-14 w-full" />;

  /* Either side unknown — the P&L could not state a margin — so there is nothing to
     compare. Better an em dash than a delta computed from a number we refused to print. */
  if (current === null || previous === null) {
    return (
      <div className="rounded-md border border-hairline px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
        <div className="text-[13px] text-ink-3">Not comparable — a figure is unknown.</div>
      </div>
    );
  }

  const d = compareFigures(current, previous, { partialCurrent: partial });
  const tone =
    d.kind === "up" ? "text-emerald"
    : d.kind === "down" ? "text-rose"
    : d.kind === "new" ? "text-emerald"
    : "text-ink-3";

  return (
    <div className="rounded-md border border-hairline px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[13px] tabular-nums text-ink">{rupee(current)}</span>
        <span className={cn("text-[12px] font-semibold", tone)}>{d.label}</span>
      </div>
      <div className="text-[10px] text-ink-3 tabular-nums" title={periodLabel}>
        was {rupee(previous)}
        {d.pct !== null && ` · ${d.absolute >= 0 ? "+" : "−"}${rupee(Math.abs(d.absolute))}`}
      </div>
    </div>
  );
}
