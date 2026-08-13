/**
 * Email sending — which transport this workspace uses, and whether it works.
 *
 * ─── THE HEADLINE IS "CAN WE SEND", NOT "IS IT CONFIGURED" ───────────────────
 * Every other integration card here reports whether keys are present. For email
 * that is the wrong headline, and this app has already lived the consequence:
 * renewal reminders were recorded as sent for months while nothing left the
 * building, because a missing RESEND_API_KEY made the sender fall back to a stub
 * that logged instead of sending.
 *
 * So the first thing on the card is a plain sentence saying whether mail is
 * actually going out right now. Keys and accounts are detail underneath it.
 *
 * The switch itself cannot select a transport that cannot send — the server
 * checks the target's scopes and returns 409 with the missing step, and that
 * message is shown verbatim rather than replaced with "Something went wrong".
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";

interface EmailSettings {
  provider: "resend" | "gmail";
  fromAddress: string | null;
  fromName: string | null;
  hasResendKey: boolean;
  hasEnvResendKey: boolean;
  gmail: { senderId: string | null; email: string | null; canSend: boolean };
  canSendNow: boolean;
}

export default function EmailSendingCard() {
  const qc = useQueryClient();
  const [fromAddress, setFromAddress] = React.useState("");
  const [fromName, setFromName] = React.useState("");
  const [resendKey, setResendKey] = React.useState("");
  const [dirty, setDirty] = React.useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["integrations", "email-provider"],
    queryFn: async (): Promise<EmailSettings> => {
      const res = await fetch("/api/integrations/email-provider");
      if (!res.ok) throw new Error("Could not load email settings");
      return res.json();
    },
  });

  // Seed the inputs once, and never again — re-seeding on every refetch would
  // wipe what the user is typing the moment another query invalidates this one.
  React.useEffect(() => {
    if (data && !dirty) {
      setFromAddress(data.fromAddress ?? "");
      setFromName(data.fromName ?? "");
    }
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await fetch("/api/integrations/email-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      // The server's message names the missing step (connect Google, tick the
      // send permission). Replacing it with a generic failure would throw away
      // the only part that tells the user what to do.
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      return json;
    },
    onSuccess: () => {
      toast.success("Email settings saved");
      setResendKey("");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["integrations", "email-provider"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <Card className="p-5">
        <p className="text-sm font-semibold text-ink">Email sending</p>
        <p className="mt-2 text-xs text-ink-3">Loading…</p>
      </Card>
    );
  }

  // Separate from the loading branch on purpose. Written as `isLoading || !data`
  // it rendered "Loading…" forever whenever the request failed — a transient
  // error became a permanent mystery with no way to retry and nothing on screen
  // saying anything was wrong. Found in the browser; no unit test would have.
  if (error || !data) {
    return (
      <Card className="p-5">
        <p className="text-sm font-semibold text-ink">Email sending</p>
        <p className="mt-2 text-xs text-ink-2">
          Could not load email settings.{" "}
          {error instanceof Error ? error.message : "The request did not complete."}
        </p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
          Try again
        </Button>
      </Card>
    );
  }

  const gmailReady = data.gmail.canSend;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Email sending</p>
          <p className="mt-0.5 text-xs text-ink-3">
            How renewal reminders, invoices and quotes leave this workspace.
          </p>
        </div>
        <Badge kind={data.canSendNow ? "success" : "danger"}>
          {data.canSendNow ? "Sending" : "Not sending"}
        </Badge>
      </div>

      {/* The sentence that matters. Stated before any configuration detail. */}
      {!data.canSendNow && (
        <div className="mb-4 flex gap-2.5 rounded-lg border border-rose/30 bg-rose-soft/40 p-3">
          <Icon name="alert_triangle" className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <div className="text-xs leading-relaxed text-ink-2">
            <span className="font-medium text-ink">No mail is going out.</span>{" "}
            {data.provider === "gmail"
              ? "Gmail is selected but the connected account cannot send."
              : "Resend is selected but no API key is set, so emails are recorded as sent and silently discarded."}
          </div>
        </div>
      )}

      {/* ── Provider ─────────────────────────────────────────────────────── */}
      <Label>Provider</Label>
      <div className="mb-4 mt-1.5 grid grid-cols-2 gap-2">
        {(["resend", "gmail"] as const).map((p) => {
          const active = data.provider === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => save.mutate({ provider: p })}
              disabled={save.isPending}
              className={[
                "rounded-lg border p-3 text-left transition-colors",
                active ? "border-amber bg-amber-soft/40" : "border-hairline hover:bg-paper-2",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {p === "resend" ? "Resend" : "Gmail"}
                </span>
                {active && <Icon name="check" size={14} className="text-amber-ink" />}
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-ink-3">
                {p === "resend"
                  ? "Reports bounces. Needs a verified domain."
                  : gmailReady
                    ? `Sends as ${data.gmail.email}`
                    : "Not connected for sending"}
              </p>
            </button>
          );
        })}
      </div>

      {/* Stated plainly because it is the reason Resend is the default and it is
          invisible until a customer's address goes dead. */}
      {data.provider === "gmail" && (
        <p className="mb-4 text-[11px] leading-relaxed text-ink-3">
          Gmail does not report bounces. A dead customer address will fail
          silently and this app will still record the email as sent.
        </p>
      )}

      {/* ── Gmail connection ─────────────────────────────────────────────── */}
      <div className="mb-4 rounded-lg border border-hairline p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">Google account</p>
            <p className="truncate text-[11px] text-ink-3">
              {gmailReady
                ? `${data.gmail.email} · ready to send`
                : data.gmail.email
                  ? `${data.gmail.email} · send permission missing`
                  : "Not connected"}
            </p>
          </div>
          <a href="/api/integrations/google-gmail/connect" className="shrink-0">
            <Button variant="outline" size="sm">
              {gmailReady ? "Reconnect" : "Connect"}
            </Button>
          </a>
        </div>
      </div>

      {/* ── Resend key + From ────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div>
          <Label htmlFor="resend-key">Resend API key</Label>
          <Input
            id="resend-key"
            value={resendKey}
            onChange={(e) => { setResendKey(e.target.value); setDirty(true); }}
            placeholder={data.hasResendKey ? "•••••••• (saved — leave blank to keep)" : "re_..."}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            {data.hasResendKey
              ? "A key is saved for this workspace. Leaving this blank keeps it — it is never deleted by saving."
              : data.hasEnvResendKey
                ? "Using the shared deployment key. Add your own so your sending is billed and reputed separately."
                : "No key anywhere. Nothing can be sent through Resend until one is set."}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="from-address">From address</Label>
            <Input
              id="from-address"
              value={fromAddress}
              onChange={(e) => { setFromAddress(e.target.value); setDirty(true); }}
              placeholder="billing@yourdomain.in"
            />
          </div>
          <div>
            <Label htmlFor="from-name">From name</Label>
            <Input
              id="from-name"
              value={fromName}
              onChange={(e) => { setFromName(e.target.value); setDirty(true); }}
              placeholder="Excel Technologies"
            />
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-ink-3">
          The domain must be verified inside your own Resend account, or Resend
          rejects the send. Holding a valid key with an unverified domain is the
          most common reason mail quietly stops.
        </p>

        <Button
          onClick={() => save.mutate({
            fromAddress,
            fromName,
            // Omitted entirely when blank, so the server's "keep" branch runs.
            ...(resendKey ? { resendApiKey: resendKey } : {}),
          })}
          loading={save.isPending}
          disabled={!dirty}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}
