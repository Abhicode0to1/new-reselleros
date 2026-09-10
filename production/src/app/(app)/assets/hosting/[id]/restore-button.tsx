"use client";

/**
 * "Restore" — put a suspended hosting account back on.
 *
 * ─── WHY IT ASKS FOR A REASON BUT DOES NOT DEMAND ONE ───────────────────────
 * Restoring after a refund gives a customer service the books say they have paid
 * back, so "why is this on again?" is a real question six months later. But a
 * required field on a one-click recovery is friction on the safe direction, and
 * the operator's name and the timestamp are recorded either way — the reason only
 * adds the half a machine cannot know. So it is offered, prominently, and the
 * audit row says "No reason given" when it is skipped rather than pretending one
 * was supplied.
 *
 * ─── IT DOES NOT CLAIM THE SITE IS BACK ─────────────────────────────────────
 * The route marks the row; the 15-minute cron tells DirectAdmin. The toast says
 * so, in those words. A success message reading "restored" would have an operator
 * telling the customer their site is up while it is still off, and the next call
 * is the one where we look like we do not know our own system.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function RestoreButton({
  hostingId,
  domainName,
}: {
  hostingId: string;
  domainName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function restore() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/hosting/${hostingId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        /* Both halves come back on every refusal from that route. */
        toast.error(body.error ?? "Could not restore that just now.", {
          description: body.nextStep,
          duration: 12_000,
        });
        return;
      }

      setOpen(false);
      setReason("");
      toast.success(`${domainName} marked active`, {
        /* The route's own sentence, verbatim — it is the accurate one. */
        description: body.message,
        duration: 10_000,
      });
      /* The status pill, the "Suspended" fact and this button all change. */
      router.refresh();
    } catch (e) {
      toast.error("Could not reach the server", {
        description: `${(e as Error).message}. Nothing was changed — the account is still suspended.`,
        action: { label: "Try again", onClick: () => void restore() },
        duration: 12_000,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-4 pt-4 border-t border-hairline">
        <Button variant="default" onClick={() => setOpen(true)}>
          Restore this account
        </Button>
        <p className="text-2xs text-ink-3 mt-2">
          Puts the site and mailboxes back on. Reversible, and nothing is deleted either way.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-hairline">
      <p className="text-sm text-ink-2">
        Restore <span className="font-mono">{domainName}</span>?
      </p>
      <p className="text-2xs text-ink-3 mt-1">
        If it was suspended by a refund, the money side does not change — this only turns the
        service back on.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why? (optional, kept in the audit log)"
          className="max-w-[320px]"
          maxLength={500}
        />
        <Button variant="primary" loading={busy} onClick={restore}>
          Restore now
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setReason("");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
