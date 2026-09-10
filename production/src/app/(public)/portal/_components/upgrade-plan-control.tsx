"use client";

/**
 * "Move to a bigger plan" — the customer choosing their own hosting upgrade.
 *
 * ─── WHAT IT SHOWS, AND THE ONE NUMBER IT REFUSES TO SHOW ───────────────────
 * It shows the MONTHLY difference ("₹137 more a month"), which is a stable fact
 * about the price list and will still be true next week.
 *
 * It does NOT show the amount the customer will actually be charged. That figure
 * is pro-rata to their renewal date, so it falls every single day the request
 * waits in the queue — see `lib/hosting/plan-change.ts`. Printing it here would
 * put a number in front of the customer that the quote then contradicts, which is
 * precisely the mistake `seat-request.ts` documents at the top of its own file.
 * So the copy promises a price rather than quoting one.
 *
 * ─── IT NEVER OFFERS A SMALLER PLAN ─────────────────────────────────────────
 * The options come from `upgradeOptions`, which returns strictly bigger plans and
 * returns NOTHING when the account's current plan cannot be identified. A
 * downgrade needs a disk-usage check and a credit note, and DirectAdmin applies a
 * package immediately — so a smaller plan chosen by a customer could take a live
 * site down. That conversation goes to a human.
 *
 * ─── A REQUEST ALREADY WAITING REPLACES THE CHOOSER ─────────────────────────
 * Not just disables it. A customer looking at a live "Request upgrade" button
 * will press it again, and the second press is a 409 they did not need to see.
 * There is a unique index behind this (`uq_hosting_plan_changes_one_pending`)
 * because the button is not the guard, but the screen should not invite the
 * mistake in the first place.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errors/toast-error";
import { upgradeOptions, planFromCode, type HostingPlanSpec } from "@/lib/hosting/plan-change";
import { rupee } from "@/lib/utils";

export function UpgradePlanControl({
  hostingId,
  domainName,
  currentPlanCode,
  pendingTo,
}: {
  hostingId: string;
  domainName: string;
  /** Whatever is stored — `plan_code`, else `da_package`, else `plan_name`. */
  currentPlanCode: string | null;
  /** The plan code of a request already waiting, if there is one. */
  pendingTo: string | null;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<HostingPlanSpec | null>(null);

  const current = planFromCode(currentPlanCode);
  const options = upgradeOptions(currentPlanCode);
  const pending = planFromCode(pendingTo);

  /* Already asked — this run or a previous visit. Same screen either way, so a
     reload does not put the button back. */
  const waitingFor = sent ?? pending;
  if (waitingFor) {
    return (
      <div className="mt-4 pt-4 border-t border-hairline">
        <p className="text-2xs text-ink-2">
          <b>Upgrade to {waitingFor.name} requested.</b> We will send you the price for the rest of
          your term — nothing changes until you accept it.
        </p>
        <p className="text-3xs text-ink-3 mt-1">
          Need it sooner?{" "}
          <Link href="/portal/support/new" className="underline">
            Tell us
          </Link>
          .
        </p>
      </div>
    );
  }

  /* Nothing to offer: an unidentifiable plan, or already on the largest. Both are
     silent rather than an empty box with a heading — but the top plan says so,
     because "why is there no upgrade button?" deserves an answer (§24). */
  if (options.length === 0) {
    if (!current) return null;
    return (
      <div className="mt-4 pt-4 border-t border-hairline">
        <p className="text-2xs text-ink-3">
          {current.name} is our largest shared plan.{" "}
          <Link href="/portal/support/new" className="underline">
            Ask about a server of your own
          </Link>{" "}
          if you are outgrowing it.
        </p>
      </div>
    );
  }

  async function request(plan: HostingPlanSpec) {
    if (busy) return;
    setBusy(plan.code);
    try {
      const res = await fetch(`/api/portal/hosting/${hostingId}/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requested_plan_code: plan.code }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        /* Every refusal from that route is written for this customer, so it is
           shown as it came. */
        toastError(body.error ?? "Could not send that just now. Please try again.");
        return;
      }

      setSent(plan);
      toast.success(`Upgrade to ${plan.name} requested`, {
        description: `We will send you the price to move ${domainName} for the rest of your term.`,
        duration: 8000,
      });
    } catch {
      toastError("Could not reach us just now. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-hairline">
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Need more room?</p>
      <ul className="mt-2 space-y-2">
        {options.map((p) => {
          /* The MONTHLY difference. Rounded once, for display only — the charge
             is computed in paise at approval. */
          const delta = current ? Math.round(p.monthlyRate - current.monthlyRate) : null;
          return (
            <li
              key={p.code}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-hairline bg-paper-2/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-ink font-medium">{p.name}</p>
                <p className="text-2xs text-ink-3">
                  {p.storage} disk · {p.bandwidth} bandwidth · {p.sites === "1" ? "1 website" : "multiple websites"}
                  {delta !== null && delta > 0 ? ` · ${rupee(delta)} more a month` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="default"
                loading={busy === p.code}
                onClick={() => request(p)}
              >
                Move to {p.name}
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-3xs text-ink-3 mt-2">
        We work out the exact amount for the days left in your term and send it to you. Your site
        stays exactly as it is until then.
      </p>
    </div>
  );
}
