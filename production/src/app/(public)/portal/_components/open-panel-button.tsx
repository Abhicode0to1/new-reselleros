"use client";

/**
 * "Open control panel" — the customer's own DirectAdmin session.
 *
 * The portal twin of `(app)/assets/hosting/[id]/panel-button.tsx`, and it keeps
 * that file's one discipline exactly:
 *
 * ─── THE LINK IS NEVER PUT ANYWHERE IT COULD LINGER ──────────────────────────
 * Not an <a href>, not held in state, not copied to the clipboard. It arrives
 * from the POST, goes straight to `window.open`, and the local variable falls out
 * of scope. An href would survive in the DOM, in a right-click "copy link", and
 * in browser history — and this URL is a live session into live hosting.
 *
 * That is also why it is a POST and not a link: a GET could be prefetched or
 * followed from a stray click, minting a session nobody asked for.
 *
 * ─── A POPUP BLOCKER IS THE LIKELY FAILURE, SO IT IS NAMED ──────────────────
 * `window.open` after an await is the classic case a browser refuses, and the
 * symptom is a button that appears to do nothing. If the handle comes back null
 * the customer is told what happened and what to do, rather than being left
 * pressing it again.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

export function OpenPanelButton({
  hostingId,
  domainName,
}: {
  hostingId: string;
  domainName: string;
}) {
  const [busy, setBusy] = React.useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/portal/hosting/${hostingId}/panel`, { method: "POST" });
      const body = await res.json().catch(() => ({}));

      if (!res.ok || !body.url) {
        /* Every refusal from that route is written for this customer — suspended,
           still provisioning, not reachable — so it is shown as it came. */
        toastError(body.error ?? "Could not open the control panel just now.");
        return;
      }

      const handle = window.open(body.url, "_blank", "noopener,noreferrer");
      if (!handle) {
        toast.error("Your browser blocked the pop-up", {
          description:
            "Allow pop-ups for this site and press the button again — the link is one-time, so this one has already been used up.",
        });
        return;
      }
      toast.success(`Opening the control panel for ${domainName}`, {
        description: "The link is single-use and expires in a few minutes.",
      });
    } catch {
      toastError("Could not reach us just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={open} loading={busy} icon="external" size="sm" variant="default">
      Open control panel
    </Button>
  );
}
