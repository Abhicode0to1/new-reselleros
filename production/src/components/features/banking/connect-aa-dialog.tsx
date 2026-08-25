/**
 * ConnectAaDialog — initiate Account Aggregator consent for a bank account.
 *
 * The operator types their VUA ("virtual user address" = phone@aa-app-name,
 * e.g. "+919876543210@onemoney"), and we POST to /api/aa/setu/consent/init.
 * The server creates a consent with Setu and returns a redirect URL — we
 * open it in a new tab (Setu's hosted consent page) or in the same window
 * (the local simulate-approval page in mock mode).
 *
 * The drawer also explains *what* AA is for the typical SME operator who
 * has never heard of it.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { useInitiateAaConsent } from "@/lib/queries/bank-aa";

interface Props {
  open:          boolean;
  onOpenChange:  (open: boolean) => void;
  bankAccountId: string;
  bankName:      string;
}

export function ConnectAaDialog({ open, onOpenChange, bankAccountId, bankName }: Props) {
  const initiate = useInitiateAaConsent();
  const [vua, setVua] = React.useState("");
  const [windowDays, setWindowDays] = React.useState(180);

  React.useEffect(() => {
    if (!open) { setVua(""); setWindowDays(180); }
  }, [open]);

  const handleConnect = async () => {
    if (!vua || !vua.includes("@")) {
      toast.error("Enter a valid VUA (phone@aa-app, e.g. +919876543210@onemoney)");
      return;
    }
    try {
      const { redirectUrl } = await initiate.mutateAsync({
        bank_account_id:   bankAccountId,
        vua,
        fetch_window_days: windowDays,
      });
      // Open in new tab so operator can come back here after approving.
      // For mock mode this navigates to /aa/simulate-approval.
      onOpenChange(false);
      window.open(redirectUrl, "_blank", "noopener,noreferrer");
    } catch {
      /* hook toasts the error */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] md:max-w-[560px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>Connect {bankName} via Account Aggregator</SheetTitle>
          <SheetDescription>
            One-time consent. After you approve on your phone, ResellerOS will
            auto-fetch your transactions daily — no more CSV downloads.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Explainer */}
          <div className="rounded-md border border-hairline bg-paper-2/40 p-4 space-y-3 text-[12px] text-ink-2 leading-relaxed">
            <div className="flex items-center gap-2">
              <Icon name="info" size={14} className="text-indigo" />
              <p className="text-xs font-semibold text-ink">What is an Account Aggregator?</p>
            </div>
            <p>
              The Account Aggregator (AA) framework is RBI-regulated. With your
              one-time consent, your bank securely shares transaction data with
              ResellerOS — read-only, for the period you approve, revocable
              anytime. No screen-scraping, no shared passwords.
            </p>
            <p>
              <b className="text-ink">You need an AA app first.</b> Install
              OneMoney, Finvu, or NADL on your phone, register your bank
              account once. Then come back here.
            </p>
          </div>

          {/* VUA input */}
          <FormField label="Your VUA (Virtual User Address)" required htmlFor="vua">
            <Input
              id="vua"
              placeholder="+919876543210@onemoney"
              autoFocus
              value={vua}
              onChange={(e) => setVua(e.target.value)}
              className="font-mono"
            />
            <p className="text-3xs text-ink-3 mt-1">
              Format: <code>+91&lt;phone&gt;@&lt;aa-app&gt;</code>. Example:{" "}
              <code>+919876543210@onemoney</code> (or <code>@finvu</code>, <code>@nadl</code>).
            </p>
          </FormField>

          {/* Window */}
          <FormField label="Fetch history (days)" htmlFor="window">
            <Input
              id="window"
              type="number"
              min={30}
              max={365}
              value={windowDays}
              onChange={(e) => setWindowDays(parseInt(e.target.value, 10) || 180)}
            />
            <p className="text-3xs text-ink-3 mt-1">
              How many days of past transactions to pull on first sync. Bank
              max is usually 365 days. After this, daily auto-sync picks up
              only new entries.
            </p>
          </FormField>

          <div className="rounded-md bg-amber-soft/50 border border-amber/30 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
            <Badge kind="warning" size="sm" dot className="mb-1">Status</Badge>
            <p>
              <b>Mock mode active.</b> Without Setu API keys configured, this
              opens a simulated approval screen so you can see the full flow.
              Add <code>SETU_AA_CLIENT_ID</code>, <code>SETU_AA_SECRET</code>,{" "}
              <code>SETU_AA_BASE_URL</code>, <code>SETU_AA_REDIRECT_URL</code>{" "}
              to env to switch to live Setu API.
            </p>
          </div>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="link"
            loading={initiate.isPending}
            onClick={handleConnect}
          >
            Continue to consent
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
