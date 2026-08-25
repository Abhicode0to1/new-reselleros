/**
 * RecordProjectPaymentDialog — log money received against a milestone.
 *
 * Optionally links a real unreconciled bank CREDIT line so the bank statement
 * entry gets reconciled to this payment in one step (no double counting — the
 * project payment is a receivable record, the bank line is the actual cash).
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useRecordProjectPayment, type ProjectMilestoneRow } from "@/lib/queries/projects";
import { rupee, formatDate } from "@/lib/utils";

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  milestone:    ProjectMilestoneRow | null;
  projectId:    string;
}

type CreditLine = { id: string; txn_date: string; description: string; credit: number };

function useUnreconciledCredits(enabled: boolean) {
  return useQuery({
    queryKey: ["bank_transactions", "unreconciled_credits"],
    enabled,
    queryFn: async (): Promise<CreditLine[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("bank_transactions")
        .select("id, txn_date, description, credit")
        .gt("credit", 0)
        .is("matched_to_type", null)
        .order("txn_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CreditLine[];
    },
  });
}

export function RecordProjectPaymentDialog({ open, onOpenChange, milestone, projectId }: Props) {
  const record = useRecordProjectPayment();
  const { data: credits } = useUnreconciledCredits(open);

  const [amount, setAmount]       = React.useState("");
  const [method, setMethod]       = React.useState("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [date, setDate]           = React.useState("");
  const [bankTxnId, setBankTxnId] = React.useState("");

  React.useEffect(() => {
    if (open && milestone) {
      setAmount(String(milestone.total_amount));
      setMethod("bank_transfer");
      setReference("");
      setDate(milestone.due_date ?? new Date().toISOString().slice(0, 10));
      setBankTxnId("");
    }
  }, [open, milestone]);

  // If the operator picks a bank line, snap the amount + date to it.
  React.useEffect(() => {
    if (!bankTxnId) return;
    const c = credits?.find((x) => x.id === bankTxnId);
    if (c) { setAmount(String(c.credit)); setDate(c.txn_date); }
  }, [bankTxnId, credits]);

  if (!milestone) return null;
  const amountNum = Math.max(0, Math.round(Number(amount) || 0));
  const canSubmit = amountNum > 0 && date && !record.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      await record.mutateAsync({
        milestoneId: milestone.id,
        projectId,
        amount:      amountNum,
        method:      method || null,
        reference:   reference.trim() || null,
        receivedAt:  date,
        bankTxnId:   bankTxnId || null,
      });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Record payment — {milestone.label}</DialogTitle>
          <DialogDescription>
            Milestone amount {rupee(milestone.total_amount)}. Records money received against this milestone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount received (₹)" required htmlFor="pp_amount">
              <Input id="pp_amount" inputMode="numeric" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField label="Date" required htmlFor="pp_date">
              <Input id="pp_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Method" htmlFor="pp_method">
              <select
                id="pp_method" value={method} onChange={(e) => setMethod(e.target.value)}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              >
                <option value="bank_transfer">Bank transfer</option>
                <option value="upi">UPI</option>
                <option value="cheque">Cheque</option>
                <option value="cash">Cash</option>
                <option value="razorpay">Razorpay</option>
              </select>
            </FormField>
            <FormField label="Reference" htmlFor="pp_ref">
              <Input id="pp_ref" placeholder="UTR / cheque no." value={reference} onChange={(e) => setReference(e.target.value)} />
            </FormField>
          </div>

          <FormField label="Link a bank statement credit (optional)" htmlFor="pp_bank">
            <select
              id="pp_bank" value={bankTxnId} onChange={(e) => setBankTxnId(e.target.value)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              <option value="">— Don&apos;t link —</option>
              {(credits ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {rupee(c.credit)} · {formatDate(c.txn_date)} · {c.description.slice(0, 40)}
                </option>
              ))}
            </select>
            <p className="text-3xs text-ink-3 mt-1">
              Reconciles the actual bank credit to this payment — the bank line is the cash, this is the receivable.
            </p>
          </FormField>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" loading={record.isPending} disabled={!canSubmit} onClick={handleSubmit}>
            Record {rupee(amountNum)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
