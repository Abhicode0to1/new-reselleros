/**
 * GST and income-tax payments booked from bank lines (migration 20260925140000).
 * Booking goes through the `book_bank_txn_as_tax` RPC, which validates, records the
 * tax, books any interest / late fee as an expense and reconciles the line in one
 * transaction. Un-reconciling the line (reconcile_bank_txn) reverses all of it.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import type { TaxPaymentKind } from "@/lib/supabase/database.types";

export type TaxPayment = {
  id: string;
  kind: TaxPaymentKind;
  amount: number;
  interest: number;
  late_fee: number;
  period: string | null;
  fy: string | null;
  paid_on: string;
  bank_txn_id: string | null;
};

export function useTaxPayments() {
  return useQuery({
    queryKey: ["tax-payments"],
    queryFn: async (): Promise<TaxPayment[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tax_payments")
        .select("id, kind, amount, interest, late_fee, period, fy, paid_on, bank_txn_id")
        .order("paid_on", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TaxPayment[];
    },
    staleTime: 30_000,
  });
}

export function useBookBankTxnAsTax() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      transactionId: string;
      accountId: string;
      kind: TaxPaymentKind;
      period?: string | null;
      fy?: string | null;
      interest?: number;
      lateFee?: number;
      notes?: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("book_bank_txn_as_tax", {
        p_txn_id:   input.transactionId,
        p_kind:     input.kind,
        p_period:   input.kind === "gst" ? (input.period ?? null) : null,
        p_fy:       input.kind === "gst" ? null : (input.fy ?? null),
        p_interest: Math.max(0, Math.round(input.interest ?? 0)),
        p_late_fee: Math.max(0, Math.round(input.lateFee ?? 0)),
        p_notes:    input.notes ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions", input.accountId] });
      qc.invalidateQueries({ queryKey: ["tax-payments"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["accounting", "gst"] });
      qc.invalidateQueries({ queryKey: ["itr-pack"] });
      toast.success(input.kind === "gst" ? "Booked as GST payment & reconciled" : "Booked as income-tax payment & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book the tax payment" }),
  });
}
