"use client";

/**
 * Objection battlecards — a drawer a rep can open mid-call.
 *
 * Design constraint that shaped everything here: this is read WHILE the customer is on
 * the phone. So the objection is the heading (that is what you scan for), the response
 * is one paragraph, and there is a copy button because half the time the objection
 * arrives over WhatsApp rather than voice.
 *
 * The vendor is pre-selected from the deal's plan when the plan names one. When it does
 * not, no tab is selected and the rep picks — see `vendorFromPlan`, which returns null
 * rather than guessing, because opening the Google cards on a Zoho deal would put the
 * wrong words in a rep's mouth.
 */
import * as React from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { BATTLECARDS, battlecardsFor, vendorFromPlan, type BattlecardVendor } from "@/lib/leads/battlecards";

export function BattlecardDrawer({ open, onClose, plan }: {
  open: boolean;
  onClose: () => void;
  /** The deal's plan, used only to pre-select a vendor. */
  plan?: string | null;
}) {
  const suggested = React.useMemo(() => vendorFromPlan(plan), [plan]);
  const [vendor, setVendor] = React.useState<BattlecardVendor | null>(suggested);

  // Re-open on a different deal → re-suggest. Without this the drawer keeps the vendor
  // from the last lead, which is the same wrong-words-in-the-rep's-mouth failure.
  React.useEffect(() => { if (open) setVendor(suggested); }, [open, suggested]);

  const set = battlecardsFor(vendor);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied — paste it into WhatsApp or email.");
    } catch {
      toast.error("Could not copy.", { description: "Select the text and copy it manually." });
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:w-[30rem] sm:max-w-[95vw] p-0 flex flex-col" hideClose>
        <SheetHeader className="!p-5 flex flex-row items-start justify-between gap-3 border-b border-hairline">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Objection handling</p>
            <SheetTitle className="text-xl mt-1">Battlecards</SheetTitle>
            <SheetDescription className="text-xs mt-1">
              What to say when the customer pushes back.
            </SheetDescription>
          </div>
          <IconButton icon="x" aria-label="Close" onClick={onClose} />
        </SheetHeader>

        {/* Vendor tabs */}
        <div className="flex gap-1 border-b border-hairline px-5">
          {BATTLECARDS.map((v) => (
            <button
              key={v.vendor}
              type="button"
              onClick={() => setVendor(v.vendor)}
              aria-pressed={vendor === v.vendor}
              className={cn(
                "px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors",
                vendor === v.vendor ? "border-amber text-amber-ink" : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!set ? (
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-4 text-sm text-ink-2">
              <p className="font-medium text-ink">Pick a vendor above.</p>
              <p className="mt-1 text-[12px] leading-snug text-ink-3">
                {plan
                  ? <>This deal&apos;s plan (<span className="font-mono">{plan}</span>) doesn&apos;t name one, so nothing is pre-selected — the wrong vendor&apos;s answers are worse than none.</>
                  : <>No plan is set on this deal yet, so there is nothing to pre-select from.</>}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-emerald/30 bg-emerald-soft/30 p-3">
                <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Where it genuinely wins</p>
                <p className="mt-1 text-[13px] leading-snug text-ink">{set.strength}</p>
              </div>

              {set.cards.map((c) => (
                <div key={c.objection} className="rounded-lg border border-hairline bg-paper p-3.5">
                  <div className="flex items-start gap-2">
                    <Icon name="message" size={14} className="mt-[3px] shrink-0 text-ink-3" />
                    <p className="flex-1 text-sm font-semibold text-ink leading-snug">&ldquo;{c.objection}&rdquo;</p>
                  </div>

                  <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{c.response}</p>

                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => copy(c.response)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper-2 px-2 py-1 text-2xs font-semibold text-ink hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    >
                      <Icon name="copy" size={11} /> Copy reply
                    </button>
                  </div>

                  {c.avoid && (
                    <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-rose-soft/40 px-2 py-1.5">
                      <Icon name="alert" size={11} className="mt-[3px] shrink-0 text-rose" />
                      <p className="text-2xs leading-snug text-ink-2">
                        <b className="text-rose">Don&apos;t say:</b> {c.avoid}
                      </p>
                    </div>
                  )}
                </div>
              ))}

              <p className="text-2xs leading-snug text-ink-3">
                No card quotes a price or a date — those change per customer, and a stale number here
                becomes a promise a rep makes without knowing it is stale. Numbers belong on the quote.
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
