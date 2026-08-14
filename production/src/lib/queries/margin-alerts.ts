/**
 * Subscriptions whose margin has gone thin or negative — the repricing queue.
 *
 * ─── HOW A SUBSCRIPTION IS MATCHED TO ITS CATALOG COST ──────────────────────
 * There is no foreign key from `subscriptions` to `items`; the link is the plan NAME
 * plus the vendor, and the two are written from different vocabularies. See
 * lib/subscriptions/plan-match.ts — an EXACT name match covers only 6 of the 29
 * products the add-subscription dialog can write, missing the two highest-volume
 * Google plans, so this uses `planKey` on both sides.
 *
 * An unmatched subscription is REPORTED as unmatched, never dropped. 21 of those 29
 * products have no catalog row at all; hiding them would make an app with no cost
 * data look like an app with healthy margins.
 *
 * ─── WHY THE COST IS TODAY'S, NOT THE ONE ON THE QUOTE ──────────────────────
 * The whole point is to catch a vendor price RISE after the sale. The quote's
 * `total_cost` records what the cost was then; the catalog records what it is now.
 * Comparing today's catalog cost against the price the customer is locked into is
 * what surfaces the bleed.
 *
 * `cost at sale` is NOT passed here. `subscriptions` does not store it, and the linked
 * quote's `total_cost` is a whole-quote figure that cannot be divided back into a
 * reliable per-seat cost when a quote carries more than one line. So this reports the
 * margin as it stands TODAY without claiming to know what it was at signing —
 * `costRose` and `erodedBps` stay null, which detectErosion is built to tolerate: the
 * loss is what to act on, the history is only the explanation.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { rupeesToPaise, type Paise } from "@/lib/subscriptions/proration";
import { detectErosion, type ErosionResult, THIN_MARGIN_BPS } from "@/lib/subscriptions/margin";
import { buildPlanIndex, matchPlan } from "@/lib/subscriptions/plan-match";

export interface MarginAlert extends Partial<ErosionResult> {
  subscriptionId: string;
  customerName:   string;
  plan:           string;
  vendor:         string;
  seats:          number;
  /** True when no catalog item matched — cost unknown for a structural reason. */
  unmatched:      boolean;
  /** Why it did not match, for a message that names the actual problem. */
  unmatchedReason: "no_such_plan" | "ambiguous" | null;
  sellPerSeatMonthPaise: Paise;
  costPerSeatMonthPaise: Paise | null;
}

/** ₹/seat/month wholesale from a catalog row. Mirrors resolveMonthlyCost. */
function catalogCostPerSeatMonth(item: {
  wholesale: number | null;
  prices: unknown;
}): number {
  const p = item.prices as { annual?: { wholesale?: number } } | null;
  const annual = p?.annual?.wholesale;
  if (typeof annual === "number" && Number.isFinite(annual) && annual > 0) return annual;
  if (typeof item.wholesale === "number" && item.wholesale > 0) return item.wholesale;
  return 0;
}

export function useMarginAlerts(thinBelowBps: number = THIN_MARGIN_BPS) {
  return useQuery({
    queryKey: ["margin-alerts", thinBelowBps],
    queryFn: async (): Promise<MarginAlert[]> => {
      const supabase = createClient();

      const [{ data: subs, error: sErr }, { data: items, error: iErr }] = await Promise.all([
        supabase
          .from("subscriptions")
          .select("id, customer_name, plan, vendor, seats, mrr, quote_id, status")
          .eq("status", "active"),
        supabase.from("items").select("name, vendor, wholesale, prices"),
      ]);
      if (sErr) throw sErr;
      if (iErr) throw iErr;

      const index = buildPlanIndex(
        (items ?? []).map((it) => ({
          name:   it.name,
          vendor: String(it.vendor),
          costPerSeatMonth: catalogCostPerSeatMonth(it),
        })),
      );

      const alerts: MarginAlert[] = [];
      for (const s of subs ?? []) {
        const seats = s.seats ?? 0;
        if (seats <= 0) continue;

        // mrr is ₹/month for the WHOLE subscription (add-seats.ts states this).
        const sellPerSeatMonthPaise = rupeesToPaise((s.mrr ?? 0) / seats);

        const hit = matchPlan(index, String(s.vendor), s.plan);

        const common = {
          subscriptionId: s.id,
          customerName:   s.customer_name ?? "—",
          plan:           s.plan ?? "—",
          vendor:         String(s.vendor),
          seats,
          sellPerSeatMonthPaise,
        };

        if (!hit.matched) {
          // Reported, not hidden: a plan we cannot price is its own problem.
          alerts.push({
            ...common,
            unmatched: true,
            unmatchedReason: hit.reason,
            costPerSeatMonthPaise: null,
            needsRepricing: false,
          });
          continue;
        }

        const costPaise = rupeesToPaise(hit.costPerSeatMonth);
        const erosion = detectErosion({
          sellPerSeatMonthPaise,
          costPerSeatMonthPaise: costPaise,
          seats,
          vendor: String(s.vendor),
          thinBelowBps,
        });

        alerts.push({
          ...common,
          unmatched: false,
          unmatchedReason: null,
          costPerSeatMonthPaise: costPaise,
          ...erosion,
        });
      }

      /* Worst first: losses, then thin margins, then unpriceable rows. Sorting by
         annual rupees rather than by percentage — a 2% margin on ₹50 lakh matters
         more than a 2% margin on ₹500, and the operator has finite attention. */
      return alerts.sort((a, b) => {
        const rank = (x: MarginAlert) =>
          x.status === "loss" ? 0 : x.status === "thin" ? 1 : x.unmatched ? 2 : 3;
        const d = rank(a) - rank(b);
        return d !== 0 ? d : (a.grossAnnualPaise ?? 0) - (b.grossAnnualPaise ?? 0);
      });
    },
  });
}
