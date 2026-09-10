"use client";

/**
 * Paid for, not delivered — the queue, and the one action on it.
 *
 * ─── WHY THIS IS THE MOST IMPORTANT LIST ON THE SCREEN ──────────────────────
 * Every row is a customer who has PAID US and has no domain. Almost always the
 * ResellerClub wallet was empty when the order went up (see
 * lib/resellerclub/reseller.ts, which now watches that balance daily). The
 * provisioning cron retries on a bounded budget and then STOPS — deliberately,
 * because a name somebody else took in the meantime will never register, and a
 * row that never stops looking busy is a row nobody looks at. When it stops, it
 * lands here, and a person decides.
 *
 * That hand-off is the whole feature. This is the receiving end of it.
 *
 * ─── THE TOTAL IS AT THE TOP BECAUSE IT IS THE POINT ────────────────────────
 * A list of four failed registrations reads as a technical backlog. "₹4,847 taken
 * for domains nobody has" reads as what it is. The sort is by money for the same
 * reason.
 *
 * ─── RESOLVING RECORDS A DECISION; IT DOES NOT MOVE MONEY ───────────────────
 * Choosing "Refunded" here does NOT issue a refund — that goes through the
 * payment path with its own guards. This writes down who decided what, and takes
 * the row out of the queue. Keeping those separate means "mark it sorted" and
 * "give the customer ₹1,200 back" are not the same click, and only one of them
 * is undoable.
 */

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { RESOLUTIONS, type Resolution } from "@/lib/domains/retry";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

export interface UndeliveredRow {
  id: string;
  domain_name: string;
  amount_paid: number | null;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  customer_name: string | null;
}

/** What each resolution means, in the words an operator would use. */
const RESOLUTION_LABEL: Record<Resolution, string> = {
  refunded: "Refunded the customer",
  re_registered: "Registered it by hand",
  alternative_offered: "Offered a different name",
  written_off: "Written off",
};

export function PaidNotDelivered({ initial }: { initial: UndeliveredRow[] }) {
  const [rows, setRows] = React.useState(initial);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [resolution, setResolution] = React.useState<Resolution>("refunded");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  /* Nulls count as nothing towards the total but the row still shows — a failure
     with no recorded amount is a gap in the record, not a cheap problem, and
     treating it as ₹0 would bury it under every real figure. */
  const owed = rows.reduce((sum, r) => sum + (r.amount_paid ?? 0), 0);
  const unpriced = rows.filter((r) => r.amount_paid === null).length;

  if (rows.length === 0) return null;

  async function resolve(id: string, domain: string) {
    if (busy) return;
    if (note.trim().length < 3) {
      toastError("Write a short note — it is the only record of why this was the right call.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/domains/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastError(body.error ?? "Could not record that.");
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setOpenId(null);
      setNote("");
      toast.success(`${domain} resolved as ${RESOLUTION_LABEL[resolution].toLowerCase()}.`);
    } catch {
      toastError("Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 md:p-5 mb-5 border-rose/40 bg-rose-soft/20">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-lg text-ink inline-flex items-center gap-2">
          <Icon name="alert" size={15} /> Paid for, not delivered
        </h2>
        <p className="text-sm text-rose-ink font-medium tabular-nums">
          {rupee(owed)} taken
          {unpriced > 0 && (
            <span className="text-2xs text-ink-3 font-normal">
              {" "}
              + {unpriced} with no amount recorded
            </span>
          )}
        </p>
      </div>
      <p className="text-sm text-ink-3 mt-1">
        {rows.length === 1 ? "This customer has" : "These customers have"} paid and {rows.length === 1 ? "does" : "do"} not
        have the domain. Retries have run out, so each one needs a decision.
      </p>

      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="border border-hairline rounded-md bg-paper p-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="font-mono text-sm text-ink break-all">{r.domain_name}</p>
                <p className="text-2xs text-ink-3 mt-0.5">
                  {r.customer_name ?? "customer unknown"}
                  {" · "}
                  {r.attempt_count} failed attempt{r.attempt_count === 1 ? "" : "s"}
                  {r.last_attempt_at ? ` · last tried ${formatDate(r.last_attempt_at)}` : ""}
                </p>
                {r.last_error && (
                  /* The registrar's own words. An operator deciding between a
                     refund and a manual registration needs to know whether the
                     wallet was empty or the name was taken. */
                  <p className="text-2xs text-ink-3 mt-1 italic break-words">{r.last_error}</p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Badge kind={r.amount_paid ? "danger" : "warning"} size="sm">
                  {r.amount_paid ? rupee(r.amount_paid) : "amount not recorded"}
                </Badge>
                <Button
                  size="sm"
                  onClick={() => {
                    setOpenId(openId === r.id ? null : r.id);
                    setNote("");
                  }}
                  aria-expanded={openId === r.id}
                >
                  {openId === r.id ? "Cancel" : "Resolve"}
                </Button>
              </div>
            </div>

            {openId === r.id && (
              <div className="mt-3 pt-3 border-t border-hairline space-y-2">
                <label className="block">
                  <span className="text-3xs uppercase tracking-wider text-ink-3">What was done</span>
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value as Resolution)}
                    className="mt-1 w-full h-9 px-2 text-sm bg-paper border border-hairline rounded-md text-ink"
                  >
                    {RESOLUTIONS.map((v) => (
                      <option key={v} value={v}>
                        {RESOLUTION_LABEL[v]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-3xs uppercase tracking-wider text-ink-3">Why (goes on the record)</span>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="e.g. wallet was empty, topped up and registered by hand — order 12345"
                    className="mt-1 w-full px-2 py-1.5 text-sm bg-paper border border-hairline rounded-md text-ink"
                  />
                </label>
                <p className="text-2xs text-ink-3">
                  This records the decision. It does <b>not</b> issue a refund or register anything —
                  do that first, then write down what you did.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  loading={busy}
                  disabled={note.trim().length < 3}
                  onClick={() => resolve(r.id, r.domain_name)}
                >
                  Record it
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
