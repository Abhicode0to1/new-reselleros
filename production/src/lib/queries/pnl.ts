/**
 * The P&L for a period — one aggregation, shared.
 *
 * Lived inside the P&L page until 27 Sep 2026. The Balance Sheet needs the same number
 * for the whole life of the books (cumulative net profit = retained earnings), and a
 * second copy of a 200-line aggregation is how two reports come to disagree about profit.
 * Nothing here changed on the way out except the export keywords and the query key.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { buildPnl, vendorsFromSubscriptions, type PnlPeriod } from "@/lib/accounting/pnl";
import { buildExpenseReport, type ExpenseReport } from "@/lib/accounting/expense-report";
import { splitItc } from "@/lib/gst/itc";
import { projectCostForPeriod, type ProjectCostResult } from "@/lib/accounting/project-cost";

/** Wide enough to hold every entry the books have; the Balance Sheet reads profit from here. */
export const BOOKS_START = "2000-04-01";

export interface PnLNumbers {
  revenue:        number;   // Invoices ≥ status='pending' within period
  revenueCount:   number;
  cogs:           number;   // Vendor bills category 'COGS-*' within period
  cogsCount:      number;
  grossMargin:    number;
  expenses:       number;
  expensesCount:  number;
  expensesByCategory: { category: string; total: number; count: number }[];
  /** The same expense rows as a report — category, vendor, month (lib/accounting/expense-report). */
  expenseReport: ExpenseReport;
  commissions:      number;   // referral / channel-partner commissions (gross)
  commissionsCount: number;
  netProfit:      number;

  // GST snapshot
  outputGST: number;        // 18% of invoice subtotal proxy (using net_payable for simplicity)
  inputGST:  number;        // CGST + SGST + IGST on bills + CLAIMABLE gst_paid on expenses (lib/gst/itc.ts)
  /** Expense GST that is not credit (kaccha bill, no vendor GSTIN, s.17(5)) — it stays inside `expenses` as cost. */
  itcBlocked: number;
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
  /** Salary on customer projects + project-tagged expenses — lib/accounting/project-cost.ts. */
  projectCost: ProjectCostResult;
  /** employee id → name, for the project-cost drill-down. */
  employeeNames: Map<string, string>;
}

export function usePnL(range: { from: string; to: string }, enabled = true) {
  return useQuery({
    queryKey: ["accounting", "pnl", range.from, range.to],
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
        .select("id, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate")
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
        supabase.from("credit_notes").select("invoice_id, taxable_value, tax_amount, credit_date").gte("credit_date", range.from).lte("credit_date", range.to),
        supabase.from("debit_notes").select("invoice_id, taxable_value, tax_amount, debit_date").gte("debit_date", range.from).lte("debit_date", range.to),
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
        .select("amount, gst_paid, category, vendor_name, vendor_id, bill_type, expense_date, project_id, description")
        .gte("expense_date", range.from)
        .lte("expense_date", range.to);
      if (eErr) throw eErr;
      const expenseReport = buildExpenseReport(expenses ?? []);

      /* ITC (27 Sep 2026): the GST on an expense was counted twice — inside the expense AND
         as input credit — and claimed on every bill. Only GST that qualifies (GST invoice,
         vendor GSTIN, not s.17(5)) is credit; that part comes OUT of the expense cost. The
         rest stays a cost. lib/gst/itc.ts. */
      const { data: vendorRows } = await supabase.from("vendors").select("id, gstin");
      const vendorGstin = new Map((vendorRows ?? []).map((v) => [v.id, v.gstin ?? null]));
      const itc = splitItc((expenses ?? []).map((e) => ({
        gst_paid: e.gst_paid, bill_type: e.bill_type, category: e.category,
        vendorGstin: e.vendor_id ? vendorGstin.get(e.vendor_id) ?? null : null,
      })));

      const expensesPaid  = (expenses ?? []).reduce((s, e) => s + (e.amount ?? 0), 0);
      const expensesTotal = expensesPaid - itc.eligible;   // what the business bore; claimable GST is not a cost
      const expensesCount = (expenses ?? []).length;
      const expensesGst   = itc.eligible;

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

      /* ── PROJECT DELIVERY COST — salary spent building customers' software ──
         The project page records who worked on which project (project_labour). That
         salary is the cost of the project sale, so it moves from operating expenses into
         cost of goods — moved, never added, and never more than the salary booked in the
         period (lib/accounting/project-cost.ts). Revenue invoiced against a project's
         milestones is marked as project revenue so the licence ratio is not applied to it. */
      const [
        { data: labourRows, error: lErr },
        { data: emps, error: empErr },
        { data: projects, error: prErr },
        { data: milestones, error: msErr },
      ] = await Promise.all([
        supabase.from("project_labour").select("project_id, employee_id, percent, months, start_date, end_date"),
        supabase.from("employees").select("id, name, monthly_gross"),
        supabase.from("project_sales").select("id, title, customer_name, start_date"),
        supabase.from("project_milestones").select("project_id, invoice_id").not("invoice_id", "is", null),
      ]);
      if (lErr) throw lErr;
      if (empErr) throw empErr;
      if (prErr) throw prErr;
      if (msErr) throw msErr;

      const projectByInvoice = new Map((milestones ?? []).map((m) => [String(m.invoice_id), m.project_id]));
      const revenueByProjectMap = new Map<string, number>();
      for (const i of invoices ?? []) {
        const pid = projectByInvoice.get(String(i.id));
        if (pid) revenueByProjectMap.set(pid, (revenueByProjectMap.get(pid) ?? 0) + invTaxable(i));
      }
      /* A credit / debit note on a project invoice moves that project's revenue too — the
         same notes already net the statement's Revenue above, so the two stay equal. */
      for (const n of dnP ?? []) {
        const pid = n.invoice_id ? projectByInvoice.get(String(n.invoice_id)) : undefined;
        if (pid) revenueByProjectMap.set(pid, (revenueByProjectMap.get(pid) ?? 0) + (n.taxable_value ?? 0));
      }
      for (const n of cnP ?? []) {
        const pid = n.invoice_id ? projectByInvoice.get(String(n.invoice_id)) : undefined;
        if (pid) revenueByProjectMap.set(pid, (revenueByProjectMap.get(pid) ?? 0) - (n.taxable_value ?? 0));
      }
      const revenueByProject = [...revenueByProjectMap.entries()].map(([project_id, rev]) => ({ project_id, revenue: rev }));
      const projectRevenue = revenueByProject.reduce((s, r) => s + r.revenue, 0);

      const projectCost = projectCostForPeriod({
        from: range.from, to: range.to,
        allocations: (labourRows ?? []).map((l) => ({ ...l, percent: Number(l.percent), months: Number(l.months) })),
        monthlyGross: new Map((emps ?? []).map((e) => [e.id, e.monthly_gross ?? 0])),
        projects: projects ?? [],
        expenses: expenses ?? [],
        revenueByProject,
      });

      /* Commissions are an operating cost, not a cost of goods — they are paid on a sale
         that already happened, so they sit below the gross margin exactly as netProfit
         has always treated them. */
      const model = buildPnl({
        revenue,
        expenses: expensesTotal + commissions,
        billedCogs: cogs > 0 ? cogs : null,
        vendors,
        projectCost: projectCost.total,
        projectRevenue,
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
        expenses: expensesTotal, expensesCount, expensesByCategory, expenseReport,
        commissions, commissionsCount,
        netProfit,
        outputGST, inputGST, netGST, itcBlocked: itc.blocked,
        marginPct, profitPct,
        model,
        projectCost,
        employeeNames: new Map((emps ?? []).map((e) => [e.id, e.name])),
      };
    },
  });
}

