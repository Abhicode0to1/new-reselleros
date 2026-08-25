"use client";

/**
 * Autopay — the customer's own view of a standing debit permission.
 *
 * ─── THE COPY IS THE FEATURE HERE ───────────────────────────────────────────
 * This screen asks someone to let a company take money out of their bank account
 * without asking again. Everything is stated in those words, not in product words:
 * the amount, the cap, that it can be cancelled any time, and — in test mode — that
 * nothing real will move.
 *
 * ─── TEST MODE IS THE LOUDEST THING ON THE CARD ─────────────────────────────
 * Not a tooltip, not a grey footnote. A customer approving a mandate has to know
 * whether it is real, and a reseller demonstrating the flow has to be unable to
 * mistake one for the other.
 */
import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { mandateBadge, mandateHeadroom, planMandate, type MandateStatus } from "@/lib/payments/mandate";

export interface AutopayView {
  subscriptionId: string;
  planName: string;
  /** ₹ debited each cycle, including GST. */
  cycleAmount: number;
  status: MandateStatus;
  maxAmount: number | null;
  authLink: string | null;
  testMode: boolean;
}

export function AutopayCard({ view }: { view: AutopayView }) {
  const [busy, setBusy] = React.useState(false);
  const badge = mandateBadge(view.status, view.testMode);
  const headroom = mandateHeadroom({ maxAmount: view.maxAmount, nextDebit: view.cycleAmount });

  /* ─── THE SAME GATE THE ROUTE USES, ASKED BEFORE THE OFFER IS MADE ─────────
     /api/portal/mandate refuses a bill above the per-debit ceiling. Without this
     the card sold autopay — three bullet points and a button — for a bill that can
     never be authorised, and the customer only found out by clicking. Being sold
     something and then refused reads as a broken app, not as a limit.

     planMandate is called rather than re-testing `cycleAmount > MAX_MANDATE_AMOUNT`
     here. A second copy of the rule is a second thing to update, and the copy in the
     quieter place is the one that goes stale — leaving the button hidden for bills
     the server accepts, or shown for bills it rejects.

     Only consulted in the branches that OFFER setup. "Already active" and "waiting
     for approval" are also refusals from planMandate, but those states have their own
     branches below with the right thing to do in each. */
  const offer = planMandate({ current: view.status, cycleAmount: view.cycleAmount });

  const setUp = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/portal/mandate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: view.subscriptionId }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not set up autopay", { description: json.nextStep, duration: 10_000 });
        return;
      }
      if (json.authLink) {
        toast.success("Opening the approval page…", { description: json.message });
        window.location.href = json.authLink;
      } else {
        toast.error("The gateway did not return an approval link.", {
          description: "Nothing has been set up. Please try again.",
        });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm("Turn autopay off? Nothing further will be debited automatically.")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/portal/mandate", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: view.subscriptionId }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Could not cancel"); return; }
      toast.success("Autopay is off.", { description: json.message, duration: 9000 });
      window.location.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Autopay" sub={view.planName}>
      {/* Loudest element on the card when it applies. */}
      {view.testMode && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border-2 border-amber bg-amber-soft px-3 py-2">
          <Icon name="alert" size={14} className="mt-px shrink-0 text-amber-ink" />
          <p className="text-[12px] font-semibold leading-snug text-amber-ink">
            Test mode — no real money moves. Anything you approve here is a rehearsal.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge kind={badge.kind}>{badge.label}</Badge>
        <span className="text-sm tabular-nums text-ink-2">
          {rupee(view.cycleAmount)} <span className="text-2xs text-ink-3">each cycle</span>
        </span>
      </div>

      {view.status === "active" && (
        <>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            Your bank pays this automatically each cycle. You can turn it off at any time and
            nothing further will be taken.
          </p>
          {view.maxAmount != null && (
            <p className="mt-1.5 text-[12px] leading-snug text-ink-3">
              Approved for up to {rupee(view.maxAmount)} per payment.
            </p>
          )}
          {/* The trap made visible to the person it affects. */}
          {(headroom.willFail || headroom.tight) && (
            <div className={`mt-2 rounded-md px-2.5 py-2 ${headroom.willFail ? "bg-rose-soft" : "bg-amber-soft"}`}>
              <p className={`text-[12px] leading-snug ${headroom.willFail ? "text-rose" : "text-amber-ink"}`}>
                {headroom.willFail
                  ? "Your next bill is more than autopay was approved for, so it will not go through. Set autopay up again to raise the limit."
                  : headroom.message}
              </p>
            </div>
          )}
          <Button variant="ghost" size="sm" className="mt-3" loading={busy} onClick={cancel}>
            Turn autopay off
          </Button>
        </>
      )}

      {view.status === "pending_authorisation" && (
        <>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            Waiting for you to approve it in your UPI app. Until you do, nothing is debited.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {view.authLink && (
              <Button size="sm" onClick={() => { window.location.href = view.authLink!; }}>
                Open the approval page
              </Button>
            )}
            <Button variant="ghost" size="sm" loading={busy} onClick={cancel}>
              Cancel the request
            </Button>
          </div>
        </>
      )}

      {(view.status === "none" || view.status === "cancelled" || view.status === "expired") && (
        offer.allowed ? (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              Let your bank pay this bill automatically each cycle, so a renewal never lapses
              because an invoice was missed.
            </p>
            <ul className="mt-2 space-y-1 text-[12px] leading-snug text-ink-3">
              <li>· You approve it once in your UPI app.</li>
              <li>· You set an upper limit; nothing above it can ever be taken.</li>
              <li>· You can turn it off from this page at any time.</li>
            </ul>
            <Button size="sm" className="mt-3" loading={busy} onClick={setUp}>
              Set up autopay
            </Button>
          </>
        ) : (
          <Unavailable reason={offer.reason} nextStep={offer.nextStep} />
        )
      )}

      {view.status === "paused" && (
        <>
          <p className="mt-3 text-[13px] leading-relaxed text-rose">
            Autopay stopped — your bank declined the last attempt. Nothing is being collected.
          </p>
          {/* Same gate. A paused mandate on a bill that has since grown past the ceiling
              cannot be set up again either, and "Set it up again" would fail every time. */}
          {offer.allowed ? (
            <Button size="sm" className="mt-3" loading={busy} onClick={setUp}>
              Set it up again
            </Button>
          ) : (
            <Unavailable reason={offer.reason} nextStep={offer.nextStep} />
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Autopay cannot be offered on this bill — why, and what to do instead.
 *
 * Stated where the button would have been, so the answer is in the place the customer
 * was already looking. A limit explained up front is a limit; the same words after a
 * click are a failure (§24 — a block always names its next step).
 */
function Unavailable({ reason, nextStep }: { reason: string; nextStep: string }) {
  return (
    <div className="mt-3 rounded-lg border border-hairline bg-paper-2 px-3 py-2.5">
      <p className="text-[13px] font-medium leading-snug text-ink-2">{reason}</p>
      <p className="mt-1 text-[12px] leading-snug text-ink-3">{nextStep}</p>
    </div>
  );
}
