"use client";

/**
 * The approve / reject drawer.
 *
 * Two things it deliberately does that a plainer version would not:
 *
 * 1. It shows the numbers being signed off, not just the ask. An approver clicking
 *    "Approve" on a line that says "needs approval" has approved a word. The discount,
 *    the margin, and the rupee gap between list and payable are all on screen, because
 *    those are the things being agreed to and they are what gets stored.
 *
 * 2. Rejection requires a reason. A rejected quote with no reason sends the rep back to
 *    guess, and the guess is usually "lower the price again" — the opposite of what a
 *    margin rejection meant. The reason is shown to them verbatim.
 */
import * as React from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, rupee } from "@/lib/utils";
import { useDecideApproval } from "@/lib/queries/quotes";
import { canApprove, type ApprovalRequirement, type ApprovalRecord, type QuoteEconomics } from "@/lib/quotes/approval";

export function ApprovalDrawer({
  open, onOpenChange, quoteId, quoteLabel, economics, requirement, record, viewer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: string;
  quoteLabel: string;
  economics: QuoteEconomics;
  requirement: ApprovalRequirement;
  record: ApprovalRecord;
  viewer: { id: string; role: string | null | undefined };
}) {
  const decide = useDecideApproval();
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState("");

  React.useEffect(() => { if (open) { setRejecting(false); setReason(""); } }, [open, quoteId]);

  const permission = canApprove(viewer, record, requirement);
  const pct = (bps: number | null) => (bps === null ? "unknown" : `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`);
  const discountRupees = Math.max(0, economics.listTotal - economics.subtotal);

  const submit = (decision: "approved" | "rejected") => {
    if (decision === "rejected" && !reason.trim()) {
      toast.error("Say why you are rejecting it.", {
        description: "Without a reason the rep will guess, and the usual guess is to cut the price again.",
      });
      return;
    }
    decide.mutate(
      {
        id: quoteId,
        decision,
        userId: viewer.id,
        discountBps: requirement.discountBps,
        marginBps: requirement.marginBps,
        rejectionReason: decision === "rejected" ? reason.trim() : undefined,
      },
      {
        onSuccess: () => {
          toast.success(decision === "approved" ? `${quoteLabel} approved — it can be sent.` : `${quoteLabel} rejected.`);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[26rem] sm:max-w-[95vw] p-0 flex flex-col" hideClose>
        <SheetHeader className="!p-5 flex flex-row items-start justify-between gap-3 border-b border-hairline">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
              {requirement.tier === "owner" ? "Owner approval" : "Manager approval"}
            </p>
            <SheetTitle className="text-xl mt-1">{quoteLabel}</SheetTitle>
            <SheetDescription className="text-xs mt-1">
              Approve or reject the pricing on this quote.
            </SheetDescription>
          </div>
          <IconButton icon="x" aria-label="Close" onClick={() => onOpenChange(false)} />
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Why it is here */}
          <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3">
            <p className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Why it needs sign-off</p>
            <ul className="mt-1.5 space-y-1">
              {requirement.reasons.map((r) => (
                <li key={r} className="flex items-start gap-1.5 text-[12px] leading-snug text-ink-2">
                  <Icon name="alert" size={11} className="mt-[3px] shrink-0 text-amber-ink" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* The numbers being agreed to */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Figure label="List price"  value={rupee(economics.listTotal)} />
            <Figure label="Customer pays" value={rupee(economics.subtotal)} big />
            <Figure label="Discount" value={`${pct(requirement.discountBps)}`} note={discountRupees > 0 ? `${rupee(discountRupees)} off` : undefined} />
            <Figure
              label="Gross margin"
              value={pct(requirement.marginBps)}
              note={requirement.marginBps === null ? "cost missing on a line" : `${rupee(economics.subtotal - economics.totalCost)} on ${rupee(economics.totalCost)} cost`}
              tone={requirement.marginBps === null ? "warn" : requirement.marginBps < 1200 ? "bad" : undefined}
            />
          </div>

          {rejecting && (
            <div>
              <label htmlFor="reject-reason" className="block text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
                Reason (the rep sees this)
              </label>
              <textarea
                id="reject-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="e.g. Margin is too thin for a first order — hold at 10%."
                className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
              />
            </div>
          )}

          {!permission.allowed && (
            <div className="rounded-lg border border-hairline bg-paper-2/60 p-3 text-[12px] leading-snug text-ink-2">
              <b className="text-ink">{permission.reason}</b>
              <p className="mt-0.5 text-ink-3">
                {requirement.tier === "owner"
                  ? "Ask the owner to open this quote and decide."
                  : "Ask a manager or the owner to open this quote and decide."}
              </p>
            </div>
          )}
        </div>

        <SheetFooter className="!p-4 border-t border-hairline !flex-col !items-stretch gap-2">
          {permission.allowed && !rejecting && (
            <>
              <Button onClick={() => submit("approved")} disabled={decide.isPending} icon="check">
                Approve
              </Button>
              <Button variant="default" onClick={() => setRejecting(true)} disabled={decide.isPending}>
                Reject…
              </Button>
            </>
          )}
          {permission.allowed && rejecting && (
            <>
              <Button onClick={() => submit("rejected")} disabled={decide.isPending} icon="x">
                Confirm rejection
              </Button>
              <Button variant="default" onClick={() => setRejecting(false)} disabled={decide.isPending}>
                Back
              </Button>
            </>
          )}
          {!permission.allowed && (
            <Button variant="default" onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Figure({ label, value, note, big, tone }: {
  label: string; value: string; note?: string; big?: boolean; tone?: "warn" | "bad";
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-ink-3">{label}</p>
      <p className={cn(
        "mt-0.5 font-serif font-semibold tabular-nums",
        big ? "text-[19px]" : "text-[16px]",
        tone === "bad" && "text-rose",
        tone === "warn" && "text-amber-ink",
      )}>
        {value}
      </p>
      {note && <p className="mt-0.5 text-[10px] leading-snug text-ink-3">{note}</p>}
    </div>
  );
}
