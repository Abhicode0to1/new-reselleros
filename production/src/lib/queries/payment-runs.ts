/**
 * Payment runs (R-163) — data for /accounting/payment-runs.
 *
 * Reads are plain tenant-scoped selects (RLS). Every write is one of the four RPCs in
 * migration 20261005110000_payment_runs.sql, which own the rules (roles, approval, no double
 * payment); this file never writes payment_runs itself.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Payable, PayableSource, RunItem, VendorBank } from "@/lib/payables/payment-run";

export interface PaymentRun {
  id: string;
  run_no: string;
  status: "draft" | "approved" | "paid" | "cancelled";
  bank_account_id: string;
  pay_on: string;
  total: number;
  note: string | null;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_on: string | null;
  paid_at: string | null;
  items: RunItem[];
}

const KEY = ["payment-runs"] as const;

/** Everything still owed in rupees: unpaid/partial vendor bills + unpaid expenses, with MSME deadlines. */
export function usePayables() {
  return useQuery({
    queryKey: [...KEY, "payables"],
    queryFn: async (): Promise<Payable[]> => {
      const supabase = createClient();
      const [bills, exps, msme] = await Promise.all([
        supabase.from("vendor_bills")
          .select("id, bill_no, vendor_id, vendor_name, bill_date, due_date, total, paid_amount, currency, status")
          .in("status", ["unpaid", "partial"]).limit(1000),
        supabase.from("expenses")
          .select("id, bill_no, vendor_id, vendor_name, category, expense_date, due_date, amount, currency, paid")
          .eq("paid", false).limit(1000),
        supabase.rpc("msme_payables_aging", {}),
      ]);
      if (bills.error) throw new Error(bills.error.message);
      if (exps.error) throw new Error(exps.error.message);
      const msmeRows = (msme.data ?? []) as { source: string; doc_id: string; deadline: string | null; over_limit: boolean }[];
      const msmeBy = new Map(msmeRows.map((m) => [`${m.source}:${m.doc_id}`, m]));
      const inr = (c: string | null) => !c || c.toUpperCase() === "INR";
      const out: Payable[] = [];
      for (const b of bills.data ?? []) {
        const owed = Math.max(0, Number(b.total ?? 0) - Number(b.paid_amount ?? 0));
        if (!owed || !inr(b.currency)) continue;
        const m = msmeBy.get(`vendor_bill:${b.id}`);
        out.push({ source: "vendor_bill", docId: b.id, docRef: b.bill_no, vendorId: b.vendor_id, vendorName: b.vendor_name,
          billDate: b.bill_date, dueDate: b.due_date, outstanding: owed, msmeDeadline: m?.deadline ?? null, msmeOverLimit: !!m?.over_limit });
      }
      for (const e of exps.data ?? []) {
        const owed = Math.max(0, Number(e.amount ?? 0));
        if (!owed || !inr(e.currency)) continue;
        const m = msmeBy.get(`expense:${e.id}`);
        out.push({ source: "expense", docId: e.id, docRef: e.bill_no, vendorId: e.vendor_id, vendorName: e.vendor_name || e.category,
          billDate: e.expense_date, dueDate: e.due_date, outstanding: owed, msmeDeadline: m?.deadline ?? null, msmeOverLimit: !!m?.over_limit });
      }
      return out;
    },
    staleTime: 15_000,
  });
}

export function usePaymentRuns() {
  return useQuery({
    queryKey: [...KEY, "runs"],
    queryFn: async (): Promise<PaymentRun[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("payment_runs")
        .select("*, items:payment_run_items(source, doc_id, doc_ref, vendor_id, vendor_name, amount)")
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as PaymentRun[];
    },
    staleTime: 10_000,
  });
}

export function useVendorBanks() {
  return useQuery({
    queryKey: ["vendors", "banks"],
    queryFn: async (): Promise<VendorBank[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("vendors").select("id, name, bank_account_name, bank_account_no, bank_ifsc, upi_id").limit(2000);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    staleTime: 30_000,
  });
}

function useRunMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>, done: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const k of [KEY, ["vendor_bills"], ["vendor-bills"], ["vendors"], ["expenses"], ["bank_transactions"], ["bank_accounts"], ["balance-sheet"], ["accounting"], ["aging"]]) {
        qc.invalidateQueries({ queryKey: k as readonly unknown[] });
      }
      toast.success(done);
    },
    /* The database's refusals are written to be read ("VB-12 is already in another open
       payment run"); the description says what to do about the commonest ones. */
    onError: (e) => toastError(e, { description: "Nothing was changed. Refresh the page — a bill may have been paid or put in another run meanwhile." }),
  });
}

const rpc = async (name: string, args: Record<string, unknown>) => {
  const supabase = createClient();
  // The four functions are typed in database.generated.ts; the name is a union there.
  const { data, error } = await supabase.rpc(name as "approve_payment_run", args as { p_run_id: string });
  if (error) throw new Error(error.message);
  return data;
};

export const useCreatePaymentRun = () =>
  useRunMutation(
    (a: { items: { source: PayableSource; doc_id: string; amount: number }[]; bankAccountId: string; payOn: string; note?: string }) =>
      rpc("create_payment_run", { p_items: a.items, p_bank_account_id: a.bankAccountId, p_pay_on: a.payOn, p_note: a.note ?? null }),
    "Payment run created — waiting for approval",
  );
export const useApprovePaymentRun = () => useRunMutation((id: string) => rpc("approve_payment_run", { p_run_id: id }), "Approved — the bank file can be downloaded now");
export const useMarkRunPaid = () =>
  useRunMutation((a: { id: string; paidOn: string }) => rpc("mark_payment_run_paid", { p_run_id: a.id, p_paid_on: a.paidOn }), "Marked paid — bills settled and bank entries added");
export const useCancelPaymentRun = () => useRunMutation((id: string) => rpc("cancel_payment_run", { p_run_id: id }), "Payment run cancelled");
