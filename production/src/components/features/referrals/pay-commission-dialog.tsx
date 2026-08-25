/**
 * PayCommissionDialog — pay an earned referral commission out of a bank account.
 * Goes through the atomic pay_referral_commission RPC (debits the bank net of TDS
 * + marks the commission paid). Mirrors the vendor-bill payout.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import { usePayCommission } from "@/lib/queries/referral-commissions";
import type { CommissionWithPartner } from "@/lib/queries/referral-commissions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commission: CommissionWithPartner | null;
}

const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

function todayIST(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function PayCommissionDialog({ open, onOpenChange, commission }: Props) {
  const { data: accounts } = useBankAccounts();
  const pay = usePayCommission();

  const [bankId, setBankId] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(todayIST());
  const [method, setMethod] = React.useState("");

  // Cards can't pay out (they're a liability); offer real bank/cash accounts.
  const payable = (accounts ?? []).filter((a) => a.account_type !== "credit_card");

  React.useEffect(() => {
    if (open) {
      setBankId(payable[0]?.id ?? "");
      setPaidOn(todayIST());
      setMethod("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!commission) return null;

  async function submit() {
    if (!bankId) { toast.error("Pay-from account chuno."); return; }
    try {
      await pay.mutateAsync({ commissionId: commission!.id, bankAccountId: bankId, paidOn, method: method.trim() || null });
      onOpenChange(false);
    } catch {
      /* toast handled in the hook */
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="!p-5 border-b border-hairline">
          <SheetTitle>Pay commission</SheetTitle>
          <SheetDescription>
            <b>{commission.partner_name ?? "Partner"}</b> ko commission payout.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-md bg-paper-2/50 border border-hairline px-3 py-2 text-[12px] text-ink-2 space-y-1">
            <div className="flex justify-between"><span>Gross commission</span><span className="tabular-nums">{rupee(commission.gross_commission)}</span></div>
            {commission.tds_amount > 0 && (
              <div className="flex justify-between text-ink-3"><span>− TDS (194H)</span><span className="tabular-nums">− {rupee(commission.tds_amount)}</span></div>
            )}
            <div className="flex justify-between font-semibold text-ink border-t border-hairline pt-1 mt-1">
              <span>Net payable</span><span className="tabular-nums">{rupee(commission.net_payable)}</span>
            </div>
          </div>

          <FormField label="Pay from" htmlFor="pay_bank">
            {payable.length === 0 ? (
              <p className="text-[12px] text-rose">Koi bank account nahi mila. Pehle Banking me account add karein.</p>
            ) : (
              <select id="pay_bank" value={bankId} onChange={(e) => setBankId(e.target.value)} className={selectCls}>
                {payable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Paid on" htmlFor="pay_date">
              <Input id="pay_date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </FormField>
            <FormField label="Method / ref (optional)" htmlFor="pay_method">
              <Input id="pay_method" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="UPI / NEFT" />
            </FormField>
          </div>

          {commission.tds_amount > 0 && (
            <div className="rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
              ₹{commission.tds_amount.toLocaleString("en-IN")} TDS aapke paas rahega — usse govt ko deposit karna hoga (challan).
            </div>
          )}
        </div>

        <SheetFooter className="!p-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="rupee" loading={pay.isPending} onClick={submit} disabled={payable.length === 0}>
            Pay {rupee(commission.net_payable)}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
