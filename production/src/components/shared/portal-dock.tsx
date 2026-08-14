/**
 * Portal dock — one-click launch for the external consoles a reseller lives in.
 *
 * ─── EVERY PORTAL OPENS IN A REAL BROWSER TAB, NOT INSIDE THIS APP ───────────
 * The brief asked for these to render in-app behind a proxy that strips
 * X-Frame-Options. That header is not an obstacle these sites forgot to remove —
 * Google, Microsoft and the GST portal send it deliberately so that nobody can
 * display their login inside someone else's page. Stripping it would build a
 * convincing credential-phishing surface pointed at our own users, and it would
 * not even work: Google blocks embedded auth flows outright.
 *
 * So: `target="_blank"` with `rel="noopener noreferrer"`. noopener matters —
 * without it the opened page gets a handle to `window.opener` and can navigate
 * this tab somewhere else while the user is looking at the portal.
 *
 * ─── THE CREDENTIAL HELPER GOES THROUGH THE VAULT, NOT AROUND IT ─────────────
 * "Copy credentials & launch" is a real feature — every password manager has
 * it. What makes it safe is that it reads through /api/vault/[id]/reveal, which
 * writes an access-log row BEFORE returning the secret. A button that read the
 * password some other way would produce exactly the thing the vault exists to
 * prevent: an admin console password leaving storage with no record that anyone
 * looked at it.
 *
 * The clipboard is cleared after 45 seconds, because the system clipboard is
 * readable by every other application on the machine and by any web page the
 * user pastes into. Clearing is best-effort — some browsers refuse a write
 * without a user gesture — so it is a reduction in exposure window, not a
 * guarantee, and it is described that way in the UI rather than oversold.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";

export interface PortalLink {
  id: string;
  label: string;
  url: string;
  icon: string;
  /** Shown under the label. Says what the portal is FOR, not what it is. */
  hint: string;
}

/**
 * Fixed list, not user-editable, and that is the security property.
 * A dock that accepted arbitrary URLs from the database would be a stored-XSS
 * sink the moment one of them was `javascript:`; every entry here is a literal
 * in source, reviewed like code.
 */
export const PORTALS: PortalLink[] = [
  {
    id: "google-admin",
    label: "Google Admin",
    url: "https://admin.google.com",
    icon: "users",
    hint: "Customer Workspace tenants — users, seats, suspensions",
  },
  {
    id: "google-reseller",
    label: "Google Reseller Console",
    url: "https://partnersalesconsole.google.com",
    icon: "package",
    hint: "Orders, subscriptions, licence changes",
  },
  {
    id: "ms-partner",
    label: "Microsoft Partner Center",
    url: "https://partner.microsoft.com/dashboard",
    icon: "layout",
    hint: "M365 CSP orders and customer tenants",
  },
  {
    id: "gst",
    label: "GST Portal",
    url: "https://www.gst.gov.in",
    icon: "file",
    hint: "GSTR-1 / 3B filing, e-invoice, credentials",
  },
  {
    id: "traces",
    label: "TRACES",
    url: "https://www.tdscpc.gov.in",
    icon: "rupee",
    hint: "Form 26AS, TDS certificates, deductor login",
  },
  {
    id: "mca",
    label: "MCA V3",
    url: "https://www.mca.gov.in",
    icon: "layout",
    hint: "Company filings, DIN, director details",
  },
];

/** How long a copied secret stays on the clipboard before we try to clear it. */
const CLIPBOARD_TTL_MS = 45_000;

export function PortalDock({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div>
          <p className="text-sm font-semibold text-ink">Portals</p>
          <p className="mt-0.5 text-xs text-ink-3">
            Opens in a new browser tab — these consoles refuse to be embedded, by design.
          </p>
        </div>
        <Link
          href="/vault"
          className="shrink-0 text-xs text-amber-ink hover:underline"
        >
          Vault →
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-2 p-5 sm:grid-cols-2">
        {PORTALS.map((p) => (
          <a
            key={p.id}
            href={p.url}
            target="_blank"
            // noopener is load-bearing: without it the portal gets window.opener
            // and can navigate this tab while the user is looking away.
            rel="noopener noreferrer"
            className="group flex items-start gap-3 rounded-lg border border-hairline p-3 transition-colors hover:bg-paper-2"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-3 group-hover:text-ink">
              <Icon name={p.icon} size={16} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                {p.label}
                <Icon name="external" size={12} className="text-ink-3" />
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">
                {p.hint}
              </span>
            </span>
          </a>
        ))}
      </div>
    </Card>
  );
}

/**
 * Copy a stored password to the clipboard and open its console.
 *
 * `credentialId` is a vault row. The secret is fetched through the reveal route
 * so the access is logged; nothing here reads storage directly.
 */
export function useCopyCredentialAndLaunch() {
  const [busyId, setBusyId] = React.useState<string | null>(null);

  return {
    busyId,
    run: async (credentialId: string, launchUrl?: string) => {
      setBusyId(credentialId);
      try {
        const res = await fetch(`/api/vault/${credentialId}/reveal`, { method: "POST" });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error ?? "Could not read the credential");

        await navigator.clipboard.writeText(json.password);

        // Best-effort clear. Browsers may refuse a clipboard write without a
        // user gesture, so this shortens the window rather than guaranteeing
        // anything — which is why the toast says "for 45 seconds", not "safe".
        window.setTimeout(() => {
          navigator.clipboard.writeText("").catch(() => {});
        }, CLIPBOARD_TTL_MS);

        toast.success("Password copied — clipboard clears in 45 seconds", {
          description: "This access was recorded in the vault log.",
        });

        if (launchUrl) window.open(launchUrl, "_blank", "noopener,noreferrer");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not copy the credential");
      } finally {
        setBusyId(null);
      }
    },
  };
}

export default PortalDock;
