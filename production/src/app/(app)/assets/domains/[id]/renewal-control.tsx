"use client";

/**
 * Raise a renewal quote for a domain, and show one that is already open.
 *
 * ─── WHY IT SHOWS THE OPEN RENEWAL RATHER THAN JUST A BUTTON ────────────────
 * A renewal quote allocates a document number from the GST series, and a series
 * has no rollback. So a second click that lands on
 * `uq_domain_renewals_one_open` has ALREADY spent a quote number by the time it
 * fails — the route says so and tells the operator to cancel it, but the better
 * answer is not to invite the click. When a renewal is open this renders its
 * state and no button.
 *
 * ─── AND WHY IT REPORTS A REFUSAL IN FULL ───────────────────────────────────
 * The likeliest outcome on a fresh deployment is "there is no rate card entry
 * for this extension", because the rate card needs ResellerClub credentials to
 * sync and this database has none. That refusal carries a next step — run Sync
 * domains — and it has to reach the operator, not a console. A greyed button or
 * a four-second toast would leave somebody guessing at the one thing they need
 * to do.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";

export interface OpenRenewal {
  id: string;
  quote_id: string;
  years: number;
  from_expires_at: string;
  status: string;
  last_error: string | null;
  new_expires_at: string | null;
  renewed_at: string | null;
}

export function RenewalControl({
  domainId,
  domainName,
  expiresAt,
  open,
}: {
  domainId: string;
  domainName: string;
  expiresAt: string | null;
  /** The most recent renewal for this domain, whatever its state. */
  open: OpenRenewal | null;
}) {
  const router = useRouter();
  const [years, setYears] = React.useState("1");
  const [busy, setBusy] = React.useState(false);

  async function raise() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/domains/${domainId}/renewal-quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ years: Number(years) }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        /* Long duration and the next step in the description: on a fresh
           deployment this is "run Sync domains", which is the whole answer. */
        toast.error(body.error ?? "Could not raise the renewal quote.", {
          description: body.nextStep,
          duration: 15_000,
        });
        return;
      }

      toast.success(`Quote ${body.quoteId} raised — ${rupee(body.total)}`, {
        description: body.message,
        duration: 12_000,
      });
      router.refresh();
    } catch (e) {
      toast.error("Could not reach the server", {
        description: `${(e as Error).message}. Nothing was raised.`,
        action: { label: "Try again", onClick: () => void raise() },
        duration: 12_000,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 mt-5">
      <h2 className="font-serif text-lg mb-1">Renewal</h2>
      <p className="text-2xs text-ink-3 mb-4">
        The customer pays the quote; the renewal is filed at the registrar automatically once it
        clears. Nothing is filed before the money arrives.
      </p>

      {open && open.status === "quoted" && (
        <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-ink">
              Quote{" "}
              <Link href={`/quotes/${open.quote_id}` as never} className="font-mono underline">
                {open.quote_id}
              </Link>{" "}
              — {open.years} year{open.years > 1 ? "s" : ""} from {formatDate(open.from_expires_at)}
            </p>
            {/* ─── THE BADGE FOLLOWS THE REAL BLOCKER ──────────────────────
                It used to read "Waiting on payment" for every `quoted` row, and
                the browser showed why that is wrong: after the customer paid and
                the filing cron refused, the card still said we were waiting on
                them. With an error present the money is not the problem — a
                person is. */}
            <Badge kind={open.last_error ? "warning" : "info"}>
              {open.last_error ? "Needs attention" : "Waiting on payment"}
            </Badge>
          </div>
          {open.last_error && (
            /* A refusal from the filing cron. Shown here rather than only in a
               log, because every one of them needs a person. */
            <p className="text-2xs text-rose-ink mt-2">{open.last_error}</p>
          )}
        </div>
      )}

      {open && open.status === "renewed" && (
        <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-3">
          <p className="text-sm text-ink">
            Renewed{open.renewed_at ? ` on ${formatDate(open.renewed_at)}` : ""}
            {open.new_expires_at ? `, now expires ${formatDate(open.new_expires_at)}` : ""}.
          </p>
          <p className="text-2xs text-ink-3 mt-1">
            Quote <span className="font-mono">{open.quote_id}</span>
          </p>
        </div>
      )}

      {open && (open.status === "failed" || open.status === "cancelled") && (
        <div className="rounded-md border border-rose/40 bg-rose-soft/30 px-3 py-3 mb-4">
          <p className="text-sm text-ink">
            The last renewal attempt {open.status === "failed" ? "failed" : "was cancelled"}.
          </p>
          {open.last_error && <p className="text-2xs text-rose-ink mt-1">{open.last_error}</p>}
        </div>
      )}

      {/* The button appears only when there is nothing open — see the header. */}
      {(!open || open.status === "failed" || open.status === "cancelled") && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-2xs text-ink-3">
            <span className="block mb-1 uppercase tracking-wider font-semibold">Term</span>
            <Select value={years} onValueChange={setYears}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 5, 10].map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y} year{y > 1 ? "s" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button variant="primary" loading={busy} onClick={raise} disabled={!expiresAt}>
            Raise renewal quote
          </Button>
          {!expiresAt && (
            <span className="text-2xs text-ink-3">
              No expiry date on this domain yet, so there is nothing to renew from.
            </span>
          )}
        </div>
      )}

      <p className="text-3xs text-ink-3 mt-4">
        Priced from the domain rate card ({domainName.slice(domainName.indexOf("."))}). If there is
        no rate for it, this will say so rather than guess — a guessed price is filed at the
        registrar at whatever it really costs.
      </p>
    </Card>
  );
}
