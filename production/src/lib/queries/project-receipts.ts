/**
 * Project receipts from the bank — a customer's money-in line booked as a project
 * milestone payment, straight from the reconcile dialog.
 *
 * Reuses the project module's own RPCs, unchanged:
 *   create_project_sale            — only when the operator picks "Naya project"
 *   add_project_receipt_milestone  — a receipt on a project already paid in full (or an
 *                                    extra payment): one new milestone, project value grows
 *   record_project_payment         — writes project_payments AND reconciles the bank line
 *   raise_project_milestone_invoice — optional tax invoice for that milestone
 *
 * Order matters: the payment is recorded BEFORE the invoice is raised, so a fully-paid
 * milestone's invoice is dated on the day the money arrived and born "paid".
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";

export interface OpenMilestone {
  id: string;
  seq: number;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  invoiceId: string | null;
}

export interface OpenProject {
  id: string;
  title: string;
  customerName: string;
  customerId: string | null;
  total: number;
  paid: number;
  /** Unpaid milestones only. Empty when the project is paid in full. */
  milestones: OpenMilestone[];
}

/**
 * Projects that can still receive money: everything not completed / cancelled. A project
 * paid in full is included too — a second payment on it becomes a new milestone.
 */
export function useOpenProjects(enabled: boolean) {
  return useQuery({
    queryKey: ["project_sales", "open_for_receipt"],
    enabled,
    queryFn: async (): Promise<OpenProject[]> => {
      const supabase = createClient();
      const [{ data: projects, error: e1 }, { data: ms, error: e2 }, { data: pays, error: e3 }] = await Promise.all([
        supabase.from("project_sales")
          .select("id, title, customer_name, customer_id, total_amount, status, created_at")
          .not("status", "in", "(completed,cancelled)")
          .order("created_at", { ascending: false }),
        supabase.from("project_milestones").select("id, project_id, seq, label, total_amount, status, invoice_id"),
        supabase.from("project_payments").select("milestone_id, amount"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;

      const paidByMs = new Map<string, number>();
      for (const p of pays ?? []) if (p.milestone_id) paidByMs.set(p.milestone_id, (paidByMs.get(p.milestone_id) ?? 0) + (p.amount ?? 0));

      return (projects ?? []).map((p) => {
        const all = (ms ?? [])
          .filter((m) => m.project_id === p.id)
          .map((m) => {
            const paid = paidByMs.get(m.id) ?? 0;
            return {
              id: m.id, seq: m.seq, label: m.label, total: m.total_amount, paid,
              remaining: Math.max(0, m.total_amount - paid), invoiceId: m.invoice_id,
            };
          })
          .sort((a, b) => a.seq - b.seq);
        return {
          id: p.id, title: p.title, customerName: p.customer_name, customerId: p.customer_id,
          total: p.total_amount, paid: all.reduce((s, m) => s + m.paid, 0),
          milestones: all.filter((m) => m.remaining > 0),
        };
      });
    },
    staleTime: 15_000,
  });
}

/**
 * The milestones a NEW project starts with when it is created from a bank receipt:
 * one "Full payment" when the receipt is the whole value, else "Advance" (this receipt)
 * + "Balance" (the rest). GST-inclusive rupees, like every milestone.
 */
export function receiptMilestones(totalInclusive: number, received: number) {
  if (received >= totalInclusive) return [{ label: "Full payment", total_amount: totalInclusive, due_date: null }];
  return [
    { label: "Advance", total_amount: received, due_date: null },
    { label: "Balance", total_amount: totalInclusive - received, due_date: null },
  ];
}

export type ProjectReceiptTarget =
  /** milestoneId null = add a new milestone for this receipt (label: newMilestoneLabel). */
  | { kind: "existing"; projectId: string; milestoneId: string | null; newMilestoneLabel?: string }
  | {
      kind: "new";
      customerId: string | null;
      customerName: string;
      title: string;
      /** GST-inclusive project value. */
      totalInclusive: number;
      gstRate: number;
    };

export function useBookBankCreditAsProjectPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      bankTxnId: string;
      amount: number;
      receivedAt: string;
      reference: string | null;
      target: ProjectReceiptTarget;
      raiseInvoice: boolean;
    }): Promise<{ projectId: string; invoiceId: string | null }> => {
      const supabase = createClient();
      let projectId: string;
      let milestoneId: string;

      if (input.target.kind === "new") {
        const t = input.target;
        const taxable = Math.round((t.totalInclusive * 100) / (100 + t.gstRate));
        const { data: pid, error } = await supabase.rpc("create_project_sale", {
          p_customer_id: t.customerId,
          p_customer_name: t.customerName,
          p_title: t.title,
          p_description: null,
          p_taxable: taxable,
          p_gst_rate: t.gstRate,
          p_inter_state: false,
          p_milestones: receiptMilestones(t.totalInclusive, input.amount),
        });
        if (error) throw error;
        projectId = pid as string;
        const { data: first, error: mErr } = await supabase
          .from("project_milestones").select("id").eq("project_id", projectId).order("seq").limit(1).single();
        if (mErr) throw mErr;
        milestoneId = first.id;
      } else if (input.target.milestoneId) {
        projectId = input.target.projectId;
        milestoneId = input.target.milestoneId;
      } else {
        projectId = input.target.projectId;
        const { data: mid, error: addErr } = await supabase.rpc("add_project_receipt_milestone", {
          p_project_id: projectId,
          p_amount: input.amount,
          p_label: input.target.newMilestoneLabel ?? null,
        });
        if (addErr) throw addErr;
        milestoneId = mid as string;
      }

      const { error: payErr } = await supabase.rpc("record_project_payment", {
        p_milestone_id: milestoneId,
        p_amount: input.amount,
        p_method: "bank_transfer",
        p_reference: input.reference,
        p_received_at: input.receivedAt,
        p_bank_txn_id: input.bankTxnId,
      });
      if (payErr) throw payErr;

      let invoiceId: string | null = null;
      if (input.raiseInvoice) {
        const { data: ms } = await supabase.from("project_milestones").select("invoice_id").eq("id", milestoneId).single();
        if (!ms?.invoice_id) {
          const { data: inv, error: invErr } = await supabase.rpc("raise_project_milestone_invoice", { p_milestone_id: milestoneId });
          /* The payment and the reconcile are already done — a failed invoice must not
             read as a failed booking. Say so; it can be raised from the project page. */
          if (invErr) toastError(invErr, { fallback: "Payment booked, but the invoice could not be raised — raise it from the project page" });
          else invoiceId = inv as string;
        }
      }
      return { projectId, invoiceId };
    },
    onSuccess: ({ invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["project_milestones"] });
      qc.invalidateQueries({ queryKey: ["project_payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["accounting"] });
      toast.success(invoiceId ? `Project payment booked · invoice ${invoiceId} raised` : "Project payment booked & reconciled");
    },
    onError: (err) => toastError(err, { fallback: "Could not book the project payment" }),
  });
}
