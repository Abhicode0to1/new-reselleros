/**
 * DeleteBankAccountDialog — guarded, honest delete of a bank account.
 *
 * Deleting an account is destructive: its imported/manual transactions are
 * permanently removed (FK CASCADE), and any money records that were paid via
 * this account (customer payments, salaries, loans, EMI, statutory dues) keep
 * existing but lose their "paid via" link (FK SET NULL).
 *
 * So we DISCLOSE exactly what will be touched, and require the operator to
 * type the account nickname to confirm — no accidental one-click deletes.
 */
"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  useBankAccountDependencies,
  useDeleteBankAccount,
  type BankAccountRow,
} from "@/lib/queries/bank";

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  account:      BankAccountRow | null;
}

export function DeleteBankAccountDialog({ open, onOpenChange, account }: Props) {
  const { data: deps, isLoading } = useBankAccountDependencies(open ? account?.id : null);
  const del = useDeleteBankAccount();
  const [confirmText, setConfirmText] = React.useState("");

  React.useEffect(() => { if (!open) setConfirmText(""); }, [open]);

  if (!account) return null;

  const linkCleared =
    (deps?.payments ?? 0) + (deps?.salaries ?? 0) + (deps?.loans ?? 0) + (deps?.emi ?? 0) + (deps?.dues ?? 0);
  const canDelete = confirmText.trim() === account.name.trim() && !del.isPending;

  const handleDelete = async () => {
    if (!canDelete) return;
    try {
      await del.mutateAsync(account.id);
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="trash" size={18} className="text-rose" />
            Delete &ldquo;{account.name}&rdquo;?
          </DialogTitle>
          <DialogDescription>
            This permanently removes the account. It cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {isLoading ? (
            <div className="h-20 rounded-md bg-paper-2/40 animate-pulse" />
          ) : (
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3 text-sm space-y-2">
              <div className="flex items-start gap-2">
                <Icon name="alert" size={15} className="text-rose mt-0.5 shrink-0" />
                <div className="text-ink-2 leading-relaxed">
                  <b className="text-rose">{deps?.transactions ?? 0}</b> imported transaction
                  {(deps?.transactions ?? 0) === 1 ? "" : "s"} on this account will be{" "}
                  <b>permanently deleted</b>.
                </div>
              </div>
              {linkCleared > 0 && (
                <div className="flex items-start gap-2">
                  <Icon name="info" size={15} className="text-amber-ink mt-0.5 shrink-0" />
                  <div className="text-ink-2 leading-relaxed">
                    {linkCleared} money record{linkCleared === 1 ? "" : "s"}
                    {" "}({[
                      (deps?.payments ?? 0) && `${deps?.payments} payment`,
                      (deps?.salaries ?? 0) && `${deps?.salaries} salary`,
                      (deps?.loans ?? 0) && `${deps?.loans} loan`,
                      (deps?.emi ?? 0) && `${deps?.emi} EMI`,
                      (deps?.dues ?? 0) && `${deps?.dues} dues`,
                    ].filter(Boolean).join(", ")}){" "}
                    will stay, but lose their &ldquo;paid via this account&rdquo; link.
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="delete-bank-type-to-confirm" className="text-xs text-ink-2 font-medium">
              Type <b className="font-mono text-ink">{account.name}</b> to confirm
            </label>
            <Input id="delete-bank-type-to-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={account.name}
              className="mt-1.5"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            icon="trash"
            disabled={!canDelete}
            loading={del.isPending}
            onClick={handleDelete}
          >
            Delete account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
