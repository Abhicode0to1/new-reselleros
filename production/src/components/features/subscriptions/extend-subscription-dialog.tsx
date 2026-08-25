/**
 * ExtendSubscriptionDialog — operator-facing UI to issue an N-year
 * extension quote against an active subscription.
 *
 * UX:
 *   • Shows the current term + new term preview
 *   • 1 / 2 / 3 year presets (clear ladder, no surprise pricing)
 *   • Live total = annual_amount × years (mrr × 12 × years)
 *   • On submit: hits /api/subscriptions/[id]/extend, redirects to the
 *     new quote so operator can review + send to customer
 *
 * Caveats:
 *   • Does NOT process payment — extension flow ALWAYS goes through
 *     quote → send → customer pays. Two clean GST invoices.
 *   • Doesn't change the existing subscription until customer pays
 *     (renewal_date stays put until then).
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { Subscription } from "@/lib/supabase/database.types";

interface Props {
  sub:    Subscription;
  open:   boolean;
  onOpenChange: (v: boolean) => void;
}

const PRESETS: { years: number; label: string; sublabel?: string }[] = [
  { years: 1, label: "1 year",  sublabel: "Add 12 months" },
  { years: 2, label: "2 years", sublabel: "Add 24 months" },
  { years: 3, label: "3 years", sublabel: "Add 36 months" },
];

export default function ExtendSubscriptionDialog({ sub, open, onOpenChange }: Props) {
  const router = useRouter();
  const [years, setYears] = React.useState(1);
  const [submitting, setSubmitting] = React.useState(false);

  // Pricing preview — annual × years (matches what the API will quote)
  const annualEstimate = Math.max(0, (sub.mrr ?? 0) * 12);
  const totalEx = annualEstimate * years;
  const gstAmt  = Math.round(totalEx * 0.18);
  const totalIn = totalEx + gstAmt;

  // Term preview
  const currentRenewal = sub.renewal_date ? new Date(sub.renewal_date) : null;
  const newRenewal = currentRenewal
    ? new Date(currentRenewal.getTime() + years * 365.25 * 86400000)
    : null;

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const res  = await fetch(`/api/subscriptions/${sub.id}/extend`, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ years }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not create extension quote");
        return;
      }
      toast.success(`Extension quote ${json.quoteId} created`);
      onOpenChange(false);
      router.push(`/quotes/${json.quoteId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">
            Subscription · Extend
          </p>
          <h2 className="font-serif text-2xl text-ink">{sub.customer_name}</h2>
          {sub.domain && (
            <p className="text-xs font-mono text-ink-3 mt-0.5">{sub.domain}</p>
          )}
          <p className="text-xs text-ink-2 mt-1">{sub.plan} · {sub.seats} seats</p>
        </header>

        {/* Term preview */}
        <div className="bg-paper-2 rounded-md p-3 mb-4 text-sm flex justify-between items-center">
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Current renewal</p>
            <p className="font-medium text-ink tabular-nums">
              {currentRenewal ? formatDate(currentRenewal.toISOString()) : "—"}
            </p>
          </div>
          <div className="text-ink-3">→</div>
          <div className="text-right">
            <p className="text-3xs uppercase tracking-wider text-emerald font-semibold">New renewal</p>
            <p className="font-medium text-emerald tabular-nums">
              {newRenewal ? formatDate(newRenewal.toISOString()) : "—"}
            </p>
          </div>
        </div>

        {/* Preset chooser */}
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          How many years to add?
        </p>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {PRESETS.map((p) => (
            <button
              key={p.years}
              type="button"
              onClick={() => setYears(p.years)}
              className={cn(
                "border rounded-md p-3 text-left transition-colors",
                years === p.years
                  ? "border-amber bg-amber-soft text-amber-ink"
                  : "border-hairline bg-paper hover:border-hairline-strong text-ink-2",
              )}
            >
              <p className="font-medium text-sm">{p.label}</p>
              {p.sublabel && <p className="text-3xs text-ink-3 mt-0.5">{p.sublabel}</p>}
            </button>
          ))}
        </div>

        {/* Pricing breakdown */}
        <div className="border border-hairline rounded-md p-3 text-sm space-y-1.5 mb-2">
          <div className="flex justify-between">
            <span className="text-ink-3">Annual rate</span>
            <span className="tabular-nums text-ink-2">{rupee(annualEstimate)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">× {years} year{years === 1 ? "" : "s"}</span>
            <span className="tabular-nums text-ink-2">{rupee(totalEx)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">GST 18%</span>
            <span className="tabular-nums text-ink-2">{rupee(gstAmt)}</span>
          </div>
          <div className="flex justify-between pt-2 border-t border-hairline">
            <span className="font-medium text-ink">Total (incl GST)</span>
            <span className="font-serif text-lg tabular-nums text-ink">{rupee(totalIn)}</span>
          </div>
        </div>

        <p className="text-2xs text-ink-3 leading-relaxed mb-1">
          A separate <b className="text-ink-2">extension quote</b> will be issued — the original
          1-year invoice stays untouched. When the customer pays, the renewal date will
          advance by <Badge size="sm" kind="muted">{years * 12} months</Badge>.
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" icon="file" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Creating quote…" : `Create extension quote`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
