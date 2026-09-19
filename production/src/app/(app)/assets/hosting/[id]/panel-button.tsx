"use client";

/**
 * "Open control panel" — a one-time DirectAdmin session for this account.
 *
 * ─── THE LINK IS NEVER PUT ANYWHERE IT COULD LINGER ──────────────────────────
 * It is not rendered as an <a href>, not written to state, and not copied to the
 * clipboard. It arrives from the POST, is handed straight to `window.open`, and
 * the local variable goes out of scope. An href would survive in the DOM, in a
 * right-click "copy link", and in the browser's history — and this URL is a live
 * session into a customer's hosting.
 *
 * That is also why the button is a POST and not a link: a GET could be
 * prefetched by the browser or followed from a stray click, and either would mint
 * a session nobody asked for. See the route's header.
 *
 * ─── WHY IT SAYS IT WAS RECORDED ─────────────────────────────────────────────
 * The server writes an audit row naming who opened whose panel. Telling the
 * operator that plainly is the honest thing: it is not a hidden watcher, it is a
 * record they should expect to exist. And if the row failed to write, the toast
 * says so rather than implying an audit trail that is not there.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

export function OpenPanelButton({
  hostingId,
  domainName,
  daUsername,
}: {
  hostingId: string;
  domainName: string;
  daUsername: string | null;
}) {
  const [busy, setBusy] = React.useState(false);

  async function open() {
    setBusy(true);
    try {
      const res = await fetch(`/api/hosting/${hostingId}/sso`, { method: "POST" });
      const json = await res.json();

      if (!res.ok || !json?.ok) {
        toastError(json?.error, {
          fallback: "Could not create a control-panel link.",
          description: "Nothing was opened and no session was created, so trying again is safe.",
        });
        return;
      }

      /* Opened immediately and never stored. A blocked popup is the one failure
         worth explaining, because the link expires in minutes and the operator
         would otherwise just see nothing happen. */
      const w = window.open(json.url, "_blank", "noopener,noreferrer");
      if (!w) {
        toast.warning(
          "Your browser blocked the popup, so the link was not opened — and it expires in a few minutes.",
          { description: "Allow popups for this site and press the button again.", duration: 12_000 },
        );
        return;
      }

      const mins = Math.max(1, Math.round((json.expires_in_seconds ?? 300) / 60));
      toast.success(
        `Control panel opened for ${domainName}.`,
        {
          description: json.audited
            ? `The link is single-use and expires in ${mins} minute${mins === 1 ? "" : "s"}. This was recorded against your name.`
            : `The link is single-use and expires in ${mins} minute${mins === 1 ? "" : "s"}. NOTE: the audit record failed to save.`,
          duration: 10_000,
        },
      );
    } finally {
      setBusy(false);
    }
  }

  if (!daUsername) {
    return (
      <p className="text-sm text-ink-3">
        No cPanel username on this account yet — it is set when provisioning completes, so there is
        no panel to open.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" onClick={open} disabled={busy} className="min-h-[44px]">
        <Icon name="external" size={14} /> {busy ? "Creating link…" : "Open control panel"}
      </Button>
      <p className="text-2xs text-ink-3">
        Signs in as <span className="font-mono">{daUsername}</span>. Single-use, expires in minutes,
        and cannot change the password or 2FA.
      </p>
    </div>
  );
}
