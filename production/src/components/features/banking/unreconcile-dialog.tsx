/**
 * UnreconcileDialog — the confirm step before a bank line is freed, saying what the line
 * was booked as and what freeing it leaves behind.
 *
 * A line booked with "Invoice banao & reconcile" offers to undo that sale too (invoice
 * voided — number kept — and receipt removed), ticked by default: without it the invoice
 * stays, and booking the line again counts the same money twice.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useUnreconcileImpact, useUnreconcileBankTxn } from "@/lib/queries/unreconcile";

export function UnreconcileDialog({ txn, onClose }: { txn: BankTransactionRow | null; onClose: () => void }) {
  const { data: impact, isLoading } = useUnreconcileImpact(txn);
  const unreconcile = useUnreconcileBankTxn();
  const [undoSale, setUndoSale] = React.useState(true);

  React.useEffect(() => { setUndoSale(true); }, [txn?.id]);

  async function confirm() {
    if (!txn) return;
    await unreconcile.mutateAsync({ txnId: txn.id, undoSale: impact?.kind === "bank-sale" && undoSale });
    onClose();
  }

  const amount = txn ? (txn.credit > 0 ? txn.credit : txn.debit) : 0;

  return (
    <Dialog open={!!txn} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Un-reconcile this line?</DialogTitle>
          <DialogDescription>
            {txn ? `${formatDate(txn.txn_date)} · ${rupee(amount)} · ${txn.description ?? ""}` : ""}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="py-4 text-sm text-ink-3">Dekh rahe hain ye line kis cheez se judi hai…</p>
        ) : impact?.kind === "bank-sale" ? (
          <div className="space-y-3 text-sm text-ink-2">
            <p>
              Ye line reconcile karte waqt hi {impact.invoiceId ? <>invoice <b className="font-mono">{impact.invoiceId}</b> aur </> : null}
              ek {rupee(impact.amount)} ki receipt banayi gayi thi.
            </p>
            <label className="flex items-start gap-2 rounded-md border border-amber/50 bg-amber-soft/25 p-3">
              <input type="checkbox" checked={undoSale} onChange={(e) => setUndoSale(e.target.checked)} className="mt-1" />
              <span className="text-[13px] leading-snug">
                <b>Wo sale bhi palat do</b> — invoice void hogi (number wahi rahega, P&amp;L se hat jayegi) aur receipt hat jayegi.
                <span className="block text-2xs text-ink-3 mt-0.5">
                  Agar ye line ab kisi aur cheez (jaise project payment) mein book karni hai to ise ticked rehne do — warna wahi paisa do baar revenue mein ginega.
                </span>
              </span>
            </label>
          </div>
        ) : impact?.kind === "receipt" ? (
          <p className="text-sm text-ink-2">
            Ye line {rupee(impact.amount)} ki receipt se judi hai{impact.invoiceId ? <> (invoice <span className="font-mono">{impact.invoiceId}</span>)</> : null}.
            Receipt alag se record hui thi, isliye wo rahegi — sirf bank line free hogi.
          </p>
        ) : impact?.kind === "project" ? (
          <p className="text-sm text-ink-2">
            Ye line <b>{impact.projectTitle}</b> ke &quot;{impact.milestoneLabel}&quot; ke {rupee(impact.amount)} payment se judi hai
            {impact.invoiceId ? <> (invoice <span className="font-mono">{impact.invoiceId}</span>)</> : null}.
            Sirf bank line free hogi — project payment rahega. Agar wo payment galat tha to{" "}
            <Link href={`/projects/${impact.projectId}`} className="text-amber-ink underline">project page</Link> se hatao.
          </p>
        ) : (
          <p className="text-sm text-ink-2">
            Line wapas &quot;Unmatched&quot; ho jayegi. Capital / loan, tax challan aur prepaid advance jo is line se bane the wo bhi hat jayenge;
            expense ya salary entry rahegi, bas bank se link hatega.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="danger" loading={unreconcile.isPending} disabled={isLoading} onClick={confirm}>
            Un-reconcile{impact?.kind === "bank-sale" && undoSale ? " & sale palto" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
