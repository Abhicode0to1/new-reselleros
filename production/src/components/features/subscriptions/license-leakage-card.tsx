"use client";

/**
 * License leakage — seats we pay for but do not bill.
 *
 * ─── UNDER- AND OVER-BILLING ARE SHOWN SEPARATELY, NEVER NETTED ─────────────
 * ₹5,000 leaking on one customer and ₹5,000 over-charged on another is not "no
 * problem". It is two problems, and one of them is a refund the customer has not
 * asked for yet. A net figure of zero would hide both.
 *
 * ─── AND "NOT CHECKED" IS SHOWN AS NOT CHECKED ──────────────────────────────
 * A subscription never reconciled against the vendor has no vendor seat count.
 * Rendering it as ₹0 leakage would put a clean tick on exactly the rows nobody has
 * looked at. It gets its own count, with the way to fix it.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { Item, Subscription } from "@/lib/supabase/database.types";
import { assessLeakage, leakageTotals, leakageSortKey, type LeakageResult } from "@/lib/vendor/leakage";
import { subscriptionCogs } from "@/lib/vendor/cogs";

export function LicenseLeakageCard({ subscriptions, catalog, onReconcile }: {
  subscriptions: Subscription[];
  catalog: Item[];
  onReconcile?: () => void;
}) {
  const rows = React.useMemo(() => {
    return subscriptions
      .filter((s) => s.status === "active")
      .map((s) => {
        const cogs = subscriptionCogs(s, catalog);
        const result = assessLeakage({
          vendorSeats: s.vendor_seats,
          billedSeats: s.seats,
          assignedSeats: s.used,
          costPerSeatMonth: cogs.perSeatMonth,
          /* What the customer pays per seat, derived from MRR rather than the
             catalogue: a negotiated subscription is not on list price, and a refund
             is owed at what was actually charged. */
          pricePerSeatMonth: s.seats > 0 ? Math.round(s.mrr / s.seats) : null,
        });
        return { sub: s, result };
      })
      .sort((a, b) => leakageSortKey(a.result) - leakageSortKey(b.result));
  }, [subscriptions, catalog]);

  const totals = React.useMemo(() => leakageTotals(rows.map((r) => r.result)), [rows]);
  const actionable = rows.filter((r) => r.result.kind === "under_billed" || r.result.kind === "over_billed");

  if (rows.length === 0) return null;

  return (
    <Card title="License leakage" sub="Seats the vendor bills us for vs seats we bill the customer">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Figure
          label="Leaking (we pay, not billed)"
          value={rupee(totals.underBilledMonthly)}
          suffix="/mo"
          count={totals.underBilledCount}
          tone={totals.underBilledCount > 0 ? "bad" : undefined}
        />
        <Figure
          label="Over-billed (refund risk)"
          value={rupee(totals.overBilledMonthly)}
          suffix="/mo"
          count={totals.overBilledCount}
          tone={totals.overBilledCount > 0 ? "warn" : undefined}
        />
        <Figure
          label="Never reconciled"
          value={String(totals.unknownCount)}
          suffix={totals.unknownCount === 1 ? " subscription" : " subscriptions"}
          tone={totals.unknownCount > 0 ? "warn" : undefined}
        />
      </div>

      {totals.unpricedCount > 0 && (
        <p className="mt-2 text-[11px] leading-snug text-amber-ink">
          {totals.unpricedCount} {totals.unpricedCount === 1 ? "gap has" : "gaps have"} no catalogue cost, so the
          seats are counted above but the money is not.
        </p>
      )}

      {totals.unknownCount > 0 && onReconcile && (
        <div className="mt-3 rounded-lg border border-hairline bg-paper-2/50 p-3">
          <p className="text-[12px] leading-snug text-ink-2">
            Nothing here is guessed. {totals.unknownCount} {totals.unknownCount === 1 ? "subscription has" : "subscriptions have"} never
            been checked against the vendor, so we cannot say whether they are leaking.
          </p>
          <Button size="sm" variant="default" className="mt-2" onClick={onReconcile}>
            Reconcile against Google export
          </Button>
        </div>
      )}

      {actionable.length > 0 && (
        <ul className="mt-4 divide-y divide-hairline border-t border-hairline">
          {actionable.map(({ sub, result }) => (
            <li key={sub.id} className="py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {sub.customer_name}
                    {sub.domain && <span className="ml-1.5 font-mono text-[11px] text-ink-3">{sub.domain}</span>}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-2">{result.message}</p>
                  {sub.vendor_synced_at && (
                    <p className="mt-0.5 text-[10px] text-ink-3">
                      Vendor count from {formatDate(sub.vendor_synced_at)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <Badge kind={result.kind === "under_billed" ? "danger" : "warning"} size="sm">
                    {result.seatGap! > 0 ? `+${result.seatGap}` : result.seatGap} seats
                  </Badge>
                  {result.monthlyImpact != null && (
                    <p className={cn(
                      "mt-1 text-sm font-medium tabular-nums",
                      result.kind === "under_billed" ? "text-rose" : "text-amber-ink",
                    )}>
                      {rupee(result.monthlyImpact)}<span className="text-[10px] font-normal text-ink-3">/mo</span>
                    </p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {actionable.length === 0 && totals.unknownCount === 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald">
          <Icon name="check_circle" size={14} /> Every active subscription matches the vendor.
        </p>
      )}
    </Card>
  );
}

function Figure({ label, value, suffix, count, tone }: {
  label: string; value: string; suffix?: string; count?: number; tone?: "bad" | "warn";
}) {
  return (
    <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
      <p className="text-[10px] uppercase tracking-wider font-semibold text-ink-3">{label}</p>
      <p className={cn(
        "mt-0.5 font-serif text-lg font-bold tabular-nums",
        tone === "bad" ? "text-rose" : tone === "warn" ? "text-amber-ink" : "text-ink",
      )}>
        {value}{suffix && <span className="text-xs font-normal text-ink-3">{suffix}</span>}
      </p>
      {count != null && count > 0 && (
        <p className="mt-0.5 text-[10px] text-ink-3">
          across {count} {count === 1 ? "subscription" : "subscriptions"}
        </p>
      )}
    </div>
  );
}

export type { LeakageResult };
