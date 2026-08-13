/**
 * Balance Sheet data.
 *
 * Two parts:
 *   1. useBalanceSheetAuto()  — figures ResellerOS can compute from its own
 *      records (cash & bank, trade receivables, TDS receivable, trade payables,
 *      GST payable). All "as of now" — current live balances.
 *   2. Manual line CRUD       — operator-entered items the app doesn't track
 *      (fixed assets, loans, owner's capital, drawings, deposits…), under
 *      Assets / Liabilities / Equity.
 *
 * The page combines both and derives Equity = Total Assets − Total Liabilities
 * so the sheet always balances (retained earnings is the plug — standard for a
 * single-entry books-lite setup).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { BalanceSheetSection } from "@/lib/supabase/database.types";

export type BalanceSheetItem = {
  id:         string;
  section:    BalanceSheetSection;
  label:      string;
  amount:     number;
  sort_order: number;
  notes:      string | null;
};

export interface BalanceSheetAuto {
  cashAndBank:     number;   // sum of all bank + cash account balances
  receivables:     number;   // invoiced-but-unpaid, EXCLUDING project milestones (accrual)
  advancesFromCustomers: number; // money received before invoicing — a LIABILITY, not earnings
  projectReceivable: number; // one-time / project sales: total − payments received
  tdsReceivable:   number;   // pending TDS credits from customers
  employeeLoans:   number;   // outstanding loans/advances to employees (an asset)
  prepaidAdvances: number;   // vendor advances paid but not yet consumed (a current asset)
  fixedAssets:     number;   // cost of assets bought on EMI (an asset)
  payables:        number;   // unpaid vendor bills (total − paid)
  salaryPayable:   number;   // net salary accrued (payroll run) but not yet paid out — a liability
  salaryDuesPayable: number; // withheld TDS/PF/ESI not yet paid to govt (a liability)
  reimbursementsPayable: number; // company expenses paid from someone's own card/cash, not yet repaid (a liability)
  creditCardPayable: number; // outstanding owed on company credit-card accounts (a liability)
  emiLoansPayable: number;   // outstanding EMI/asset loans (a liability)
  businessLoansPayable: number; // outstanding principal on loans TAKEN by the company (a liability)
  gstPayable:      number;   // net GST this FY (output − input); may be negative (credit)
  fyLabel:         string;   // e.g. "FY 2026-27" for the GST caveat
}

// ── Pure helpers (unit-tested — see balance-sheet.helpers.test.ts) ──────────

/**
 * Trade receivables on an ACCRUAL basis: invoiced but unpaid, EXCLUDING invoices
 * that belong to a project milestone (those are counted by `projectReceivable`,
 * so including them here would double-count — verified in prod: of ₹7,82,639
 * unpaid invoices, ₹6,85,000 were project milestones).
 *
 * `net_payable` is preferred over `amount` because migration 0005 freezes the
 * advance adjustment into it (CGST Rule 53) — using `amount` would re-count an
 * advance that was already applied.
 */
export function computeTradeReceivables(
  openInvoices: ReadonlyArray<{ id: string; amount?: number | null; net_payable?: number | null }>,
  projectInvoiceIds: ReadonlySet<string>,
): number {
  return openInvoices
    .filter((i) => !projectInvoiceIds.has(i.id))
    .reduce((s, i) => s + (i.net_payable ?? i.amount ?? 0), 0);
}

/**
 * Advances from customers: received payments against quotes that have NO invoice
 * yet. The cash is already an asset in `cashAndBank`; this is the matching
 * liability (service still owed). Without it the equity plug reports customer
 * money as retained earnings.
 */
export function computeCustomerAdvances(
  receivedPayments: ReadonlyArray<{ quote_id?: string | null; amount?: number | null }>,
  quotes: ReadonlyArray<{ id: string; invoice_id?: string | null }>,
): number {
  const unInvoiced = new Set(quotes.filter((q) => !q.invoice_id).map((q) => q.id));
  return receivedPayments
    .filter((p) => p.quote_id != null && unInvoiced.has(p.quote_id))
    .reduce((s, p) => s + (p.amount ?? 0), 0);
}

// ── Auto figures from app records ───────────────────────────────────────────
export function useBalanceSheetAuto() {
  return useQuery({
    queryKey: ["balance-sheet", "auto"],
    queryFn: async (): Promise<BalanceSheetAuto> => {
      const supabase = createClient();

      // Cash & bank — sum current_balance across asset accounts. A credit_card
      // is a LIABILITY (balance goes negative as you spend), so its outstanding
      // is pulled OUT of cash & bank and reported separately under liabilities;
      // a rare overpaid card (positive balance) counts as cash.
      const { data: accounts, error: accErr } = await supabase
        .from("bank_accounts")
        .select("id, opening_balance, account_type");
      if (accErr) throw accErr;
      let cashAndBank = 0;
      let creditCardPayable = 0;
      for (const a of accounts ?? []) {
        const { data: bal } = await supabase.rpc("bank_account_current_balance", { p_account_id: a.id });
        const balance = (bal as number | null) ?? a.opening_balance ?? 0;
        if (a.account_type === "credit_card") {
          if (balance < 0) creditCardPayable += -balance;   // amount owed on the card
          else             cashAndBank += balance;           // overpaid card → sits as cash
        } else {
          cashAndBank += balance;
        }
      }

      // Trade receivables — ACCRUAL: invoiced but unpaid.
      //
      // Was `sum(subscriptions.outstanding_amount)`, which is a COLLECTIONS metric
      // (quote expected − received), not a balance-sheet one. Verified against prod
      // 2026-08-12: it reported ₹0 while ₹7.82L of invoices were genuinely unpaid,
      // because the spine zeroes `outstanding_amount` once payments land even though
      // the invoice is still open. It also counted amounts never invoiced (not yet
      // legally owed) and missed direct invoices entirely (no subscription row).
      // This now matches the P&L (accrual, on invoice issue) and the Aging report,
      // so revenue ↔ receivables can finally be tied. `outstanding_amount` stays
      // in use for chasing/collections UX, which is what it is good for.
      //
      // Project milestones are EXCLUDED here because `projectReceivable` below
      // already counts them — including both would double-count. Verified in prod:
      // of ₹7,82,639 unpaid invoices, ₹6,85,000 were project milestones.
      const [{ data: openInv, error: invErr }, { data: msInv, error: msInvErr }] = await Promise.all([
        supabase.from("invoices").select("id, amount, net_payable, status").in("status", ["pending", "overdue"]),
        supabase.from("project_milestones").select("invoice_id").not("invoice_id", "is", null),
      ]);
      if (invErr) throw invErr;
      if (msInvErr) throw msInvErr;
      const projectInvoiceIds = new Set((msInv ?? []).map((m) => m.invoice_id as string));
      const receivables = computeTradeReceivables(openInv ?? [], projectInvoiceIds);

      // Advances from customers — money banked BEFORE an invoice exists.
      //
      // The spine issues a Receipt Voucher for these (CGST §31(3)(d)), so the system
      // knows they are advances. The cash is already counted in `cashAndBank` above,
      // but nothing offset it, so the equity plug reported it as retained earnings —
      // i.e. customer money showed up as profit. Verified in prod: ₹8,00,189 across
      // 12 payments. Once an invoice is raised, `invoices.adjusted_advances` freezes
      // the adjustment (migration 0005) and the quote drops out of this set, so the
      // liability unwinds on its own.
      const [{ data: recdPays, error: payErr }, { data: quoteInv, error: qiErr }] = await Promise.all([
        supabase.from("payments").select("quote_id, amount, status").eq("status", "received"),
        supabase.from("quotes").select("id, invoice_id"),
      ]);
      if (payErr) throw payErr;
      if (qiErr) throw qiErr;
      const advancesFromCustomers = computeCustomerAdvances(recdPays ?? [], quoteInv ?? []);

      // Project-sale receivable — one-time deals (custom software etc.):
      // INVOICED-but-unpaid only (accrual): a milestone becomes a receivable when
      // its Tax Invoice is raised, not the whole contract value (un-invoiced
      // future milestones aren't owed yet). Mirrors the Customers list / 360.
      const { data: projs, error: prjErr } = await supabase
        .from("project_sales").select("id").in("status", ["active", "completed"]);
      if (prjErr) throw prjErr;
      const projIds = (projs ?? []).map((p) => p.id);
      let projectReceivable = 0;
      if (projIds.length > 0) {
        const [{ data: ms, error: msErr }, { data: projPays, error: ppErr }] = await Promise.all([
          supabase.from("project_milestones").select("project_id, total_amount, invoice_id").in("project_id", projIds),
          supabase.from("project_payments").select("project_id, amount").in("project_id", projIds),
        ]);
        if (msErr) throw msErr;
        if (ppErr) throw ppErr;
        const invoicedByProject = new Map<string, number>();
        for (const m of ms ?? []) if (m.invoice_id) invoicedByProject.set(m.project_id, (invoicedByProject.get(m.project_id) ?? 0) + (m.total_amount ?? 0));
        const paidByProject = new Map<string, number>();
        for (const p of projPays ?? []) paidByProject.set(p.project_id, (paidByProject.get(p.project_id) ?? 0) + (p.amount ?? 0));
        for (const id of projIds) projectReceivable += Math.max(0, (invoicedByProject.get(id) ?? 0) - (paidByProject.get(id) ?? 0));
      }

      // TDS receivable — credits not yet claimed / written off.
      const { data: tds, error: tdsErr } = await supabase
        .from("tds_receivable")
        .select("tds_amount, status")
        .in("status", ["pending_cert", "cert_received", "verified_26as"]);
      if (tdsErr) throw tdsErr;
      const tdsReceivable = (tds ?? []).reduce((s, r) => s + (r.tds_amount ?? 0), 0);

      // Employee loans / advances outstanding — principal − repayments, an asset.
      const { data: loans, error: loanErr } = await supabase
        .from("employee_loans")
        .select("id, principal");
      if (loanErr) throw loanErr;
      const { data: loanReps, error: loanRepErr } = await supabase
        .from("employee_loan_repayments")
        .select("amount");
      if (loanRepErr) throw loanRepErr;
      const loanPrincipal = (loans ?? []).reduce((s, l) => s + (l.principal ?? 0), 0);
      const loanRepaid    = (loanReps ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
      const employeeLoans = Math.max(0, loanPrincipal - loanRepaid);

      // Prepaid / vendor advances — paid but not yet consumed. A current asset.
      const { data: advs, error: advErr } = await supabase
        .from("prepaid_advances").select("total_amount, consumed_amount");
      if (advErr) throw advErr;
      const prepaidAdvances = (advs ?? []).reduce((s, a) => s + Math.max(0, (a.total_amount ?? 0) - (a.consumed_amount ?? 0)), 0);

      // Assets bought on EMI: total cost is a fixed asset; financed-minus-
      // principal-paid is a loan liability.
      const { data: emiP, error: emiErr } = await supabase.from("emi_purchases").select("total_cost, financed");
      if (emiErr) throw emiErr;
      const { data: emiPay, error: emiPayErr } = await supabase.from("emi_payments").select("principal_part");
      if (emiPayErr) throw emiPayErr;
      const fixedAssets     = (emiP ?? []).reduce((s, r) => s + (r.total_cost ?? 0), 0);
      const emiFinanced     = (emiP ?? []).reduce((s, r) => s + (r.financed ?? 0), 0);
      const emiPrincipalPaid = (emiPay ?? []).reduce((s, r) => s + (r.principal_part ?? 0), 0);
      const emiLoansPayable = Math.max(0, emiFinanced - emiPrincipalPaid);

      // Business loans taken (term/working-capital) — outstanding principal =
      // borrowed − principal repaid. A liability.
      const { data: bizLoans, error: blErr } = await supabase.from("business_loans").select("id, principal");
      if (blErr) throw blErr;
      const { data: bizPays, error: blpErr } = await supabase.from("business_loan_payments").select("principal_part");
      if (blpErr) throw blpErr;
      const bizBorrowed  = (bizLoans ?? []).reduce((s, l) => s + (l.principal ?? 0), 0);
      const bizPrincipalPaid = (bizPays ?? []).reduce((s, p) => s + (p.principal_part ?? 0), 0);
      const businessLoansPayable = Math.max(0, bizBorrowed - bizPrincipalPaid);

      // Trade payables — vendor bills with an unpaid balance.
      const { data: bills, error: bErr } = await supabase
        .from("vendor_bills")
        .select("total, paid_amount, status")
        .neq("status", "paid");
      if (bErr) throw bErr;
      const payables = (bills ?? []).reduce((s, b) => s + Math.max(0, (b.total ?? 0) - (b.paid_amount ?? 0)), 0);

      // Salary payable — net pay of salaries run but not yet paid (accrual).
      // Withheld TDS/PF/ESI on the SAME rows is separately a statutory due, so
      // we only count the tds/pf/esi of paid rows toward that (unpaid rows'
      // whole net, incl. deductions, sits here until the bank debit clears).
      const { data: salRows, error: salErr } = await supabase
        .from("salary_payments").select("net, paid_amount, tds, pf, esi, paid_status");
      if (salErr) throw salErr;
      // Payable = the still-owed slice: full net while unpaid, the remaining
      // (net − paid_amount) while partially paid, nothing once fully paid.
      const salaryPayable = (salRows ?? [])
        .filter((r) => r.paid_status !== "paid")
        .reduce((s, r) => s + Math.max(0, (r.net ?? 0) - (r.paid_amount ?? 0)), 0);
      // Salary dues payable — withheld TDS/PF/ESI on ALREADY-PAID salaries
      // (once paid, the net is out but the statutory portion is still owed to govt).
      const withheld = (salRows ?? [])
        .filter((r) => r.paid_status === "paid")
        .reduce((s, r) => s + (r.tds ?? 0) + (r.pf ?? 0) + (r.esi ?? 0), 0);
      const { data: duesPaid, error: dpErr } = await supabase.from("statutory_dues_payments").select("amount");
      if (dpErr) throw dpErr;
      const duesPaidTotal = (duesPaid ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
      const salaryDuesPayable = Math.max(0, withheld - duesPaidTotal);

      // Reimbursements payable — company expenses paid from a person's own
      // card/cash and not yet repaid. The expense already hit the P&L; this is
      // the matching payable until "Settle" (whereupon the bank transfer to the
      // person clears cash & bank instead).
      const { data: reimb, error: reimbErr } = await supabase
        .from("reimbursements").select("amount, status").eq("status", "pending");
      if (reimbErr) throw reimbErr;
      const reimbursementsPayable = (reimb ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);

      // GST payable — net for the current fiscal year (output − input). This is
      // an estimate before any GSTR filing/payment; the page footnotes it.
      const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      const fyStartYear = now.getUTCMonth() < 3 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      const fyFrom = `${fyStartYear}-04-01`;
      const fyTo   = now.toISOString().slice(0, 10);
      const fyLabel = `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;

      // Output GST — use the FROZEN tax_amount per invoice (never a hardcoded
      // 18%, which would wrongly tax a zero-rated export), then NET credit and
      // debit notes issued in the FY (credit note reduces, debit note increases).
      const { data: invoices } = await supabase
        .from("invoices")
        .select("amount, tax_amount, tax_rate, invoice_date, status")
        .gte("invoice_date", fyFrom).lte("invoice_date", fyTo)
        .in("status", ["pending", "paid", "overdue"]);
      const invGST = (invoices ?? []).reduce(
        (s, i) => s + (i.tax_amount ?? Math.round((i.amount ?? 0) * (i.tax_rate ?? 18) / (100 + (i.tax_rate ?? 18)))), 0);
      const [{ data: cnFy }, { data: dnFy }] = await Promise.all([
        supabase.from("credit_notes").select("tax_amount, credit_date").gte("credit_date", fyFrom).lte("credit_date", fyTo),
        supabase.from("debit_notes").select("tax_amount, debit_date").gte("debit_date", fyFrom).lte("debit_date", fyTo),
      ]);
      const cnGST = (cnFy ?? []).reduce((s, n) => s + (n.tax_amount ?? 0), 0);
      const dnGST = (dnFy ?? []).reduce((s, n) => s + (n.tax_amount ?? 0), 0);
      const outputGST = invGST - cnGST + dnGST;

      const { data: fyBills } = await supabase
        .from("vendor_bills")
        .select("cgst, sgst, igst, bill_date")
        .gte("bill_date", fyFrom).lte("bill_date", fyTo);
      const billsGst = (fyBills ?? []).reduce((s, b) => s + (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0), 0);

      const { data: fyExp } = await supabase
        .from("expenses")
        .select("gst_paid, expense_date")
        .gte("expense_date", fyFrom).lte("expense_date", fyTo);
      const expGst = (fyExp ?? []).reduce((s, e) => s + (e.gst_paid ?? 0), 0);

      const gstPayable = outputGST - billsGst - expGst;

      return { cashAndBank, receivables, advancesFromCustomers, projectReceivable, tdsReceivable, employeeLoans, prepaidAdvances, fixedAssets, payables, salaryPayable, salaryDuesPayable, reimbursementsPayable, creditCardPayable, emiLoansPayable, businessLoansPayable, gstPayable, fyLabel };
    },
    staleTime: 30_000,
  });
}

// ── Manual lines ────────────────────────────────────────────────────────────
export function useBalanceSheetItems() {
  return useQuery({
    queryKey: ["balance-sheet", "items"],
    queryFn: async (): Promise<BalanceSheetItem[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("balance_sheet_items")
        .select("id, section, label, amount, sort_order, notes")
        .order("section", { ascending: true })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as BalanceSheetItem[];
    },
  });
}

export function useCreateBalanceSheetItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { section: BalanceSheetSection; label: string; amount: number; notes?: string | null }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { error } = await supabase.from("balance_sheet_items").insert({
        tenant_id: me.tenant_id,
        section:   input.section,
        label:     input.label,
        amount:    input.amount,
        notes:     input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["balance-sheet", "items"] });
      toast.success("Line added");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useUpdateBalanceSheetItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; label: string; amount: number }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("balance_sheet_items")
        .update({ label: input.label, amount: input.amount })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["balance-sheet", "items"] });
      toast.success("Line updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useDeleteBalanceSheetItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("balance_sheet_items").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["balance-sheet", "items"] });
      toast.success("Line removed");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
