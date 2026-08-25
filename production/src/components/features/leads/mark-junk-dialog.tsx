"use client";

/**
 * "Mark as junk" — and say why.
 *
 * ─── THE REASON IS MANDATORY, AND NOT AS A FORMALITY ────────────────────────
 * `is_junk` on its own records that somebody binned a lead and nothing about whether
 * a real enquiry is hiding behind it. "Fake number" is live again the moment a real
 * number arrives; "student enquiry" never will be. Afterwards the two look identical,
 * so nobody dares un-bin either and genuine enquiries stay dead.
 *
 * That is why there is a dialog at all rather than a one-tap bin. One tap is faster
 * and it throws away the only fact that makes the decision reversible.
 *
 * ─── AND THE DIALOG SAYS WHAT EACH CHOICE DOES ──────────────────────────────
 * Every option carries its consequence — kept findable, or counted against the
 * source. A rep picking between four labels with no stated effect is guessing, and
 * the guess lands in the reporting.
 */
import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  JUNK_REASONS, junkNoteRequired, validateJunk, type JunkReasonId,
} from "@/lib/leads/qualification";

export interface MarkJunkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Company name, so the dialog names what is about to be binned. */
  leadName: string;
  busy?: boolean;
  onConfirm: (input: { reasonId: JunkReasonId; note: string }) => void;
}

export function MarkJunkDialog({
  open, onOpenChange, leadName, busy, onConfirm,
}: MarkJunkDialogProps) {
  const [reasonId, setReasonId] = React.useState<JunkReasonId | null>(null);
  const [note, setNote] = React.useState("");

  /* Cleared on every open. A reason left over from the last lead is the worst
     possible default — it is plausible, so nobody notices it. */
  React.useEffect(() => {
    if (open) { setReasonId(null); setNote(""); }
  }, [open]);

  const validation = reasonId
    ? validateJunk({ reasonId, note })
    : { ok: false as const, error: "Pick a reason before marking this as junk." };

  const selected = JUNK_REASONS.find((r) => r.id === reasonId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {leadName} as junk?</DialogTitle>
        </DialogHeader>

        <p className="text-[12px] leading-snug text-ink-3">
          It leaves your working lists but is never deleted. Saying why is what makes
          this reversible later.
        </p>

        <div className="mt-3 space-y-1.5">
          {JUNK_REASONS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setReasonId(r.id)}
              aria-pressed={reasonId === r.id}
              className={cn(
                "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                reasonId === r.id
                  ? "border-ink bg-paper-2"
                  : "border-hairline hover:bg-paper-2/50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-ink">{r.label}</span>
                {/* Stated on the option, not buried in a tooltip — recoverability is
                    the whole reason this dialog exists. */}
                <Badge kind={r.recoverable ? "info" : "muted"} size="sm">
                  {r.recoverable ? "Can be undone" : "Final"}
                </Badge>
              </div>
              <p className="mt-0.5 text-2xs leading-snug text-ink-3">{r.consequence}</p>
            </button>
          ))}
        </div>

        {/* Only for "Something else". Always-visible free text invites a note nobody
            reads instead of a reason anybody can group by. */}
        {reasonId && junkNoteRequired(reasonId) && (
          <div className="mt-3">
            <label htmlFor="junkNote" className="block text-2xs font-semibold uppercase tracking-wider text-ink-3">
              What was it?
            </label>
            <textarea
              id="junkNote"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. duplicate of L-99, or wrong company entirely"
              className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] text-ink"
            />
          </div>
        )}

        {selected && !validation.ok && (
          <p className="mt-2 text-[12px] text-rose">{validation.error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={!validation.ok || busy}
            onClick={() => { if (reasonId && validation.ok) onConfirm({ reasonId, note: note.trim() }); }}
          >
            Mark as junk
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
