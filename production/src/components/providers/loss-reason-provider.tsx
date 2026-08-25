/**
 * LossReasonProvider — asks "why did we lose this?" the moment a deal is marked
 * lost, and resolves a promise with the answer.
 *
 * Modelled on ConfirmProvider deliberately: a lead's stage can be changed from
 * SEVEN places (kanban drag, drawer button, drawer dropdown, bulk bar, mobile
 * card, list row select, quick actions). Putting a dialog in each one is how the
 * four conflicting "stale" rules in this codebase happened. One provider means
 * every path asks the same question and stores the same codes.
 *
 * Capture must stay cheap or reps will route around it, so:
 *   • one click on a reason = done (the note is optional, never required)
 *   • dismissing means "don't mark it lost" — we don't silently write a loss
 *     with no reason, and we don't block the rep either; they simply stay put.
 *
 * @example
 *   const askLossReason = useLossReason();
 *   const r = await askLossReason(lead.company);
 *   if (!r) return;                       // dismissed → leave the stage alone
 *   updateStage.mutate({ id, stage: "lost", lostReason: r.code, lostNote: r.note });
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { LOSS_REASONS, type LossReasonCode } from "@/lib/leads/loss-reasons";
import { cn } from "@/lib/utils";

export interface LossReasonResult {
  code: LossReasonCode;
  note: string | null;
}

/** Resolves with the reason, or null if the user dismissed. */
type AskLossReasonFn = (companyName?: string) => Promise<LossReasonResult | null>;

const LossReasonContext = React.createContext<AskLossReasonFn | null>(null);

export function useLossReason(): AskLossReasonFn {
  const ctx = React.useContext(LossReasonContext);
  if (!ctx) throw new Error("useLossReason must be used within <LossReasonProvider>");
  return ctx;
}

export function LossReasonProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [company, setCompany] = React.useState<string | undefined>();
  const [picked, setPicked] = React.useState<LossReasonCode | null>(null);
  const [note, setNote] = React.useState("");
  const resolverRef = React.useRef<((v: LossReasonResult | null) => void) | null>(null);

  const ask = React.useCallback<AskLossReasonFn>((companyName) => {
    setCompany(companyName);
    setPicked(null);
    setNote("");
    setOpen(true);
    return new Promise<LossReasonResult | null>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const settle = React.useCallback((v: LossReasonResult | null) => {
    setOpen(false);
    resolverRef.current?.(v);
    resolverRef.current = null;
  }, []);

  // One click on a reason closes the dialog — EXCEPT "Other", which is
  // meaningless without the note, so that one waits for the text.
  const choose = (code: LossReasonCode) => {
    if (code === "other") { setPicked("other"); return; }
    settle({ code, note: note.trim() || null });
  };

  return (
    <LossReasonContext.Provider value={ask}>
      {children}
      <Dialog open={open} onOpenChange={(o) => { if (!o) settle(null); }}>
        <DialogContent className="md:!max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="question" size={18} className="text-amber" />
              Why was this lost?
            </DialogTitle>
            <DialogDescription>
              {company ? <><span className="font-medium text-ink">{company}</span> — one tap. </> : "One tap. "}
              This is what turns &ldquo;12 deals lost&rdquo; into something you can act on.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {LOSS_REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => choose(r.code)}
                className={cn(
                  "text-left rounded-lg border p-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                  picked === r.code
                    ? "border-amber bg-amber-soft/60"
                    : "border-hairline hover:border-amber/50 hover:bg-paper-2",
                )}
              >
                <div className="text-sm font-semibold text-ink">{r.label}</div>
                <div className="text-2xs text-ink-3 leading-snug mt-0.5">{r.hint}</div>
              </button>
            ))}
          </div>

          <div className="mt-1">
            <label htmlFor="loss-note" className="text-2xs font-medium text-ink-3">
              Note {picked === "other" ? <span className="text-rose">(required for “Other”)</span> : "(optional)"}
            </label>
            <textarea
              id="loss-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything worth remembering next time…"
              className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber"
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            {/* Dismissing does NOT mark the deal lost — §24: the way out is
                explicit, and it says what will happen. */}
            <button
              type="button"
              onClick={() => settle(null)}
              className="text-xs text-ink-3 hover:text-ink underline underline-offset-2"
            >
              Cancel — leave the stage unchanged
            </button>
            {picked === "other" && (
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!note.trim()}
                onClick={() => settle({ code: "other", note: note.trim() })}
              >
                Save reason
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </LossReasonContext.Provider>
  );
}
