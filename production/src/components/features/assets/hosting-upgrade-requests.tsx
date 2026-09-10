"use client";

/**
 * Customers waiting to be moved to a bigger hosting plan.
 *
 * The hosting twin of `features/subscriptions/seat-requests-card.tsx`, and it
 * keeps that card's two habits:
 *
 *   · IT RENDERS NOTHING WHEN THE QUEUE IS EMPTY. A permanent "0 requests" panel
 *     costs vertical space on a screen an operator reads every day, and teaches
 *     them to skip the region — which is the last thing you want from the region
 *     that occasionally holds work.
 *
 *   · THE VERDICT IS SHOWN, NOT JUST THE BUTTON'S STATE. `assessPlanChange` is
 *     the same function the server enforces, so a request that cannot be approved
 *     says WHY here rather than presenting a dead button. A rep who cannot tell
 *     why Approve is greyed out does the change by hand at the server and forgets
 *     to close the request — and a plan changed by hand is exactly the drift that
 *     makes the next request unapprovable.
 *
 * ─── WHAT THE PRICE COLUMN DELIBERATELY DOES NOT SAY ────────────────────────
 * The pro-rata amount is worked out at approval, from the renewal date on the day
 * the button is pressed. A figure rendered here would be right for as long as this
 * tab stayed open and then quietly wrong. So this shows the MONTHLY difference —
 * a fact about the price list — and the toast after approval carries the amount
 * that was actually quoted.
 */

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { assessPlanChange, planFromCode, type HostingStatusForChange } from "@/lib/hosting/plan-change";

export interface UpgradeRequestRow {
  id: string;
  domain_name: string;
  from_plan_code: string | null;
  requested_plan_code: string;
  requested_by_email: string | null;
  note: string | null;
  created_at: string;
  /** Read from the ACCOUNT now, not stored on the request — this is what catches
   *  a plan somebody changed by hand since the customer asked. */
  live_plan_code: string | null;
  hosting_status: HostingStatusForChange;
  /** Also from the ACCOUNT. A trial has no paid term to pro-rate against. */
  is_trial: boolean;
  customer_name: string | null;
}

export function HostingUpgradeRequests({ initial }: { initial: UpgradeRequestRow[] }) {
  const [rows, setRows] = React.useState(initial);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const decide = async (id: string, decision: "approved" | "rejected", note?: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/hosting-plan-changes/${id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      const json = await res.json();
      if (!res.ok) {
        /* `nextStep` comes back on every 409 from that route. Shown as the toast's
           description so the refusal carries its own instruction (§24). */
        toast.error(json.error ?? "Could not record the decision", {
          description: json.nextStep,
          duration: 10_000,
        });
        return;
      }
      if (json.warning) {
        /* The plan IS live and something about the money is not. This must not be
           a success toast that disappears in four seconds. */
        toast.warning("Plan changed — needs your attention", {
          description: json.warning,
          duration: 20_000,
        });
      } else if (decision === "approved") {
        toast.success(
          json.quoteId
            ? `Moved to ${json.newPlan} — quote ${json.quoteId} for ${rupee(json.amount)}.`
            : `Moved to ${json.newPlan}. No charge raised — nothing left in the term to pro-rate.`,
          {
            description: json.quoteId
              ? `Pro-rated over ${json.proRataDays} of ${json.termDays} days to the renewal date.`
              : undefined,
            duration: 9000,
          },
        );
      } else {
        toast.success("Rejected. The customer will see your note.");
      }
      /* Drop the row locally rather than refetching the page: the request is
         decided either way, and leaving it would invite a second press. */
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      /* §24-complete rather than a bare message. The seat-requests card this is
         modelled on has the bare version and sits inside the ratchet's baseline;
         copying it would have raised that count, which the ratchet exists to
         stop. The decision has NOT been recorded here — nothing was changed on
         the server — so the next step really is "press it again". */
      toast.error("Could not reach the server", {
        description: `${(e as Error).message}. Nothing was changed — the request is still waiting.`,
        action: { label: "Try again", onClick: () => void decide(id, decision, note) },
        duration: 12_000,
      });
    } finally {
      setBusyId(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <Card
      title="Hosting upgrade requests"
      sub={`${rows.length} waiting on you`}
      className="mb-6"
    >
      <ul className="divide-y divide-hairline">
        {rows.map((r) => {
          const verdict = assessPlanChange({
            status: "pending",
            fromPlanCode: r.from_plan_code,
            requestedPlanCode: r.requested_plan_code,
            livePlanCode: r.live_plan_code,
            hostingStatus: r.hosting_status,
            isTrial: r.is_trial,
          });
          const to = planFromCode(r.requested_plan_code);
          const live = planFromCode(r.live_plan_code);
          const monthlyDelta =
            to && live && to.monthlyRate > live.monthlyRate
              ? Math.round(to.monthlyRate - live.monthlyRate)
              : null;

          return (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-ink break-all">{r.domain_name}</p>
                  <p className="text-2xs text-ink-3 mt-0.5">
                    {live?.name ?? r.live_plan_code ?? "unknown plan"} → <b className="text-ink-2">{to?.name ?? r.requested_plan_code}</b>
                    {monthlyDelta !== null ? ` · ${rupee(monthlyDelta)}/month more` : ""}
                    {r.customer_name ? ` · ${r.customer_name}` : ""}
                  </p>
                  <p className="text-3xs text-ink-3 mt-0.5">
                    asked {formatDate(r.created_at)}
                    {r.requested_by_email ? ` by ${r.requested_by_email}` : ""}
                  </p>
                  {r.note && <p className="text-2xs text-ink-2 mt-1 italic">“{r.note}”</p>}
                </div>

                <div className="flex items-center gap-2">
                  {verdict.canApprove ? (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busyId === r.id}
                      onClick={() => decide(r.id, "approved")}
                    >
                      Approve &amp; move
                    </Button>
                  ) : (
                    <Badge kind="warning">Cannot approve</Badge>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyId === r.id}
                    onClick={() => decide(r.id, "rejected")}
                  >
                    Reject
                  </Button>
                </div>
              </div>

              {/* The reason and the next step, in full. This is the difference
                  between a rep closing the loop and a rep working around it. */}
              {!verdict.canApprove && (
                <p className="text-2xs text-amber-ink mt-2">
                  {verdict.reason} <span className="text-ink-3">{verdict.nextStep}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-3xs text-ink-3 mt-3">
        Approving moves the DirectAdmin package straight away and raises a pro-rata quote for the
        days left in the term. The monthly figure above is the price-list difference; the exact
        amount is worked out when you approve.
      </p>
    </Card>
  );
}
