/**
 * ShareFormSheet — share/embed one of the reseller's public pages
 * (enquiry form, buy page): copy link, embed code, or send via
 * Email / WhatsApp / SMS. The URL is built from the current host so it
 * always matches whatever domain the app runs on.
 *
 * Shared by Lead Sources (/lead-gen) and the Leads page header.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** One of the reseller's PUBLIC pages that can be shared/embedded. */
export interface ShareTarget {
  /** Absolute path on this app, e.g. "/enquiry" or "/buy/workspace". */
  path: string;
  /** Kicker shown above the sheet title, e.g. "Enquiry form". */
  kicker: string;
  /** Pre-filled share message (WhatsApp / email / SMS). */
  blurb: string;
}

/** The reseller's public, shareable pages. */
export const ENQUIRY_SHARE: ShareTarget = {
  path:   "/enquiry",
  kicker: "Enquiry form",
  blurb:  "Tell us your requirement and we'll send you a quote:",
};
export const BUY_SHARE: ShareTarget = {
  path:   "/buy/workspace",
  kicker: "Google Workspace buy page",
  blurb:  "Buy Google Workspace with a GST invoice, in minutes:",
};

export function ShareFormSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}${target.path}`;
  const embed = `<iframe src="${url}?embed=1" width="100%" height="640" frameborder="0"></iframe>`;

  const shareText = `${target.blurb} ${url}`;
  const waLink   = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  const mailLink = `mailto:?subject=${encodeURIComponent(target.blurb)}&body=${encodeURIComponent(shareText)}`;
  const smsLink  = `sms:?body=${encodeURIComponent(shareText)}`;

  return (
    // ui/dialog (Radix), not a hand-rolled overlay: focus is trapped inside and handed back
    // on close, Esc closes, and the page behind is inert to a screen reader (S36).
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent hideClose resizable={false} aria-describedby={undefined} className="max-w-md p-0 gap-0">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-ink-3">{target.kicker}</p>
            <DialogTitle className="font-serif text-lg text-ink">Share or embed</DialogTitle>
          </div>
          <IconButton icon="x" variant="ghost" size="sm" aria-label="Close" onClick={onClose} />
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="mb-1 text-xs font-medium text-ink">Public link</p>
            <div className="flex gap-2">
              <Input aria-label="Public link" readOnly value={url} className="font-mono text-xs" />
              <Button variant="default" size="sm" onClick={() => { navigator.clipboard?.writeText(url); toast.success("Link copied to clipboard"); }}>
                <Icon name="copy" size={13} /> Copy
              </Button>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-ink">Embed on your website</p>
            <textarea aria-label="Embed code" readOnly value={embed} rows={3} className="w-full rounded-md border border-hairline bg-paper-2 p-2 font-mono text-xs" />
            <Button variant="default" size="sm" className="mt-1.5" onClick={() => { navigator.clipboard?.writeText(embed); toast.success("Embed code copied"); }}>
              <Icon name="copy" size={12} /> Copy embed code
            </Button>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-ink">Send via</p>
            <div className="flex gap-2 flex-wrap">
              <Button variant="default" size="sm" onClick={() => { window.location.href = mailLink; }}>
                <Icon name="mail" size={12} /> Email link
              </Button>
              <Button variant="default" size="sm" onClick={() => window.open(waLink, "_blank", "noopener")}>
                <Icon name="whatsapp" size={12} /> WhatsApp
              </Button>
              <Button variant="default" size="sm" onClick={() => { window.location.href = smsLink; }}>
                <Icon name="message" size={12} /> SMS
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
