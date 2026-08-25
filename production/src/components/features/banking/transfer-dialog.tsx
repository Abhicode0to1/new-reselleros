/**
 * TransferDialog — move money between two of the operator's own accounts.
 *
 * The main use is "withdraw cash from bank → petty cash": pick the bank account
 * as source, the cash account as destination, enter the amount. It records both
 * legs atomically via the record_account_transfer RPC (bank debit + cash
 * credit), so both balances stay correct.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useRecordTransfer, type BankAccountRow } from "@/lib/queries/bank";

const schema = z.object({
  amount:  z.coerce.number().int().min(1, "Amount required"),
  txnDate: z.string().min(1, "Date required"),
  note:    z.string().optional(),
});
type FormData = z.infer<typeof schema>;

function accountLabel(a: BankAccountRow): string {
  if (a.account_type === "cash") return `${a.name} (cash)`;
  return `${a.name} · ${a.bank_name}${a.account_number_last4 ? ` ••${a.account_number_last4}` : ""}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: BankAccountRow[];
  /** Pre-select source / destination (e.g. opening from a cash account → prefill it as destination). */
  defaultFromId?: string;
  defaultToId?: string;
}

export function TransferDialog({ open, onOpenChange, accounts, defaultFromId, defaultToId }: Props) {
  const transfer = useRecordTransfer();
  const [fromId, setFromId] = React.useState("");
  const [toId, setToId]     = React.useState("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 0, txnDate: new Date().toISOString().slice(0, 10), note: "" },
  });

  React.useEffect(() => {
    if (open) {
      // Sensible defaults: money usually moves FROM a bank INTO cash.
      const firstBank = accounts.find((a) => a.account_type !== "cash");
      const firstCash = accounts.find((a) => a.account_type === "cash");
      setFromId(defaultFromId ?? firstBank?.id ?? "");
      setToId(defaultToId ?? firstCash?.id ?? "");
      reset({ amount: 0, txnDate: new Date().toISOString().slice(0, 10), note: "" });
    }
  }, [open, accounts, defaultFromId, defaultToId, reset]);

  const sameAccount = fromId !== "" && fromId === toId;

  const onSubmit = (data: FormData) => {
    if (!fromId || !toId || sameAccount) return;
    transfer.mutate(
      { fromAccountId: fromId, toAccountId: toId, amount: Math.round(data.amount), txnDate: data.txnDate, note: data.note?.trim() || null },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[460px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Move money / withdraw</SheetTitle>
          <SheetDescription>
            Record a transfer between your own accounts — e.g. cash withdrawn from the
            bank into petty cash. Both balances update.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0 w-full">
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            <FormField label="From (money out)" required htmlFor="from-acct">
              <Select value={fromId} onValueChange={setFromId}>
                <SelectTrigger id="from-acct"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{accountLabel(a)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="To (money in)" required htmlFor="to-acct">
              <Select value={toId} onValueChange={setToId}>
                <SelectTrigger id="to-acct"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{accountLabel(a)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sameAccount && (
                <p className="mt-1 text-2xs text-rose">Source and destination must differ.</p>
              )}
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Amount (₹)" required htmlFor="amount">
                <Input id="amount" type="number" min={1} prefix="₹" error={errors.amount?.message} {...register("amount")} />
              </FormField>
              <FormField label="Date" required htmlFor="txnDate">
                <Input id="txnDate" type="date" error={errors.txnDate?.message} {...register("txnDate")} />
              </FormField>
            </div>

            <FormField label="Note (optional)" htmlFor="note">
              <Textarea id="note" rows={2} placeholder="e.g. Cash withdrawn for office petty cash" {...register("note")} />
            </FormField>

            <p className="rounded-md bg-paper-2/40 border border-hairline px-3 py-2 text-2xs text-ink-3 leading-relaxed">
              This records two entries: a debit on the source account and a matching credit
              on the destination — so no money is double-counted.
            </p>
          </div>

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting || transfer.isPending} disabled={sameAccount} icon="check">
              Record transfer
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
