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
 * Choosing SMTP is held to the same rule: the server connects and authenticates
 * against the relay first, sending nothing, and hands back the relay's own words
 * if it is refused.
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
import { blockerText, type SenderCandidate } from "@/lib/email/sender-candidates";

/** The one place a transport's machine name becomes words for a person. */
const TRANSPORT_LABEL = { resend: "Resend", gmail: "Gmail", smtp: "the SMTP relay" } as const;

interface EmailSettings {
  provider: "resend" | "gmail" | "smtp";
  fromAddress: string | null;
  fromName: string | null;
  hasResendKey: boolean;
  hasEnvResendKey: boolean;
  gmail: {
    senderId: string | null;
    /** True once a sender has been stored on the tenant, rather than assumed
     *  to be the person looking at the page. */
    isDesignated: boolean;
    email: string | null;
    canSend: boolean;
  };
  /** Every teammate, eligible first. Ineligible ones are kept so "not in the list"
   *  and "has not connected Google" stay different problems. */
  senderCandidates: SenderCandidate[];
  /** Only the owner may switch it — PATCH enforces the same. */
  canChooseSender: boolean;
  /** The deployment-wide relay. `description` is host, port and login — no password. */
  smtp: { configured: boolean; description: string };
  /** The router's own verdict — see `describeSendCapability`. */
  capability: {
    canSend: boolean;
    via: "resend" | "gmail" | "smtp";
    usingFallback: boolean;
    reason: string;
    blocked: string | null;
  };
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
  const cap = data.capability;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Email sending</p>
          <p className="mt-0.5 text-xs text-ink-3">
            How renewal reminders, invoices and quotes leave this workspace.
          </p>
        </div>
        {/* ── THREE STATES, NOT TWO ──────────────────────────────────────
            "Sending" and "Not sending" hid the case that costs money: mail IS
            leaving, through something other than what this workspace selected,
            and that transport may not report bounces. A green badge over a
            silent fallback is the same comfortable lie this card was built to
            stop. */}
        <Badge kind={!cap.canSend ? "danger" : cap.usingFallback ? "warning" : "success"}>
          {!cap.canSend ? "Not sending" : cap.usingFallback ? "Falling back" : "Sending"}
        </Badge>
      </div>

      {/* The sentence that matters. Stated before any configuration detail, and
          in the SERVER's words: `blocked` and `reason` come from the same
          function that routes a real message, so this box cannot describe a
          situation the sender does not actually have. The card used to write
          these sentences itself and they went stale — with the relay configured
          and no Resend key it said "no API key is set, so emails are recorded as
          sent and silently discarded" while every message was being delivered. */}
      {!cap.canSend && (
        <div className="mb-4 flex gap-2.5 rounded-lg border border-rose/30 bg-rose-soft/40 p-3">
          <Icon name="alert_triangle" className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <div className="text-xs leading-relaxed text-ink-2">
            <span className="font-medium text-ink">No mail is going out.</span>{" "}
            {cap.blocked}
          </div>
        </div>
      )}

      {cap.canSend && cap.usingFallback && (
        <div className="mb-4 flex gap-2.5 rounded-lg border border-amber/40 bg-amber-soft/40 p-3">
          <Icon name="alert_triangle" className="mt-0.5 h-4 w-4 shrink-0 text-amber-ink" />
          <div className="text-xs leading-relaxed text-ink-2">
            <span className="font-medium text-ink">
              Mail is going out through {TRANSPORT_LABEL[cap.via]}, not what is selected here.
            </span>{" "}
            {/* Some reasons end in a full stop and some do not — the Gmail
                ones are clause fragments ("…no sending account is chosen").
                Appending unconditionally printed "…relay instead.. Bounces",
                which the browser found and no unit test would have. */}
            {cap.reason.replace(/\.$/, "")}.{" "}
            {cap.via !== "resend" &&
              "Bounces are not reported on that path, so a dead address will look like a successful send."}
          </div>
        </div>
      )}

      {/* ── Provider ─────────────────────────────────────────────────────────
          One column on a phone. Three of these side by side at 390px leaves
          each tile about 120px wide, and "Reports bounces. Needs a verified
          domain." then wraps to five lines of two words. */}
      <Label>Provider</Label>
      <div className="mb-4 mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {(["resend", "gmail", "smtp"] as const).map((p) => {
          const active = data.provider === p;
          /* An unconfigured relay is OFFERED and disabled, not hidden. Hiding it
             makes "this deployment has no relay" and "this app cannot use a
             relay" the same screen, and the first is fixed by four env vars
             while the second sends somebody looking for code that already
             exists. The subtitle names them. */
          const unavailable = p === "smtp" && !data.smtp.configured;
          return (
            <button
              key={p}
              type="button"
              onClick={() => save.mutate({ provider: p })}
              disabled={save.isPending || unavailable}
              className={[
                "rounded-lg border p-3 text-left transition-colors",
                active ? "border-amber bg-amber-soft/40" : "border-hairline hover:bg-paper-2",
                unavailable ? "cursor-not-allowed opacity-60 hover:bg-transparent" : "",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {p === "resend" ? "Resend" : p === "gmail" ? "Gmail" : "SMTP relay"}
                </span>
                {active && <Icon name="check" size={14} className="text-amber-ink" />}
              </div>
              <p className="mt-0.5 text-2xs leading-snug text-ink-3">
                {p === "resend"
                  ? "Reports bounces. Needs a verified domain."
                  : p === "gmail"
                    ? gmailReady
                      ? `Sends as ${data.gmail.email}`
                      : "Not connected for sending"
                    : data.smtp.configured
                      /* Host, port and login, from the server. Never the password. */
                      ? data.smtp.description
                      : "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS"}
              </p>
            </button>
          );
        })}
      </div>

      {/* Stated plainly because it is the reason Resend is the default and it is
          invisible until a customer's address goes dead. The relay carries the
          identical warning — a 250 from a relay means it ACCEPTED the message,
          and the bounce arrives hours later as mail in the relay login's own
          inbox, where nobody is looking. */}
      {data.provider === "gmail" && (
        <p className="mb-4 text-2xs leading-relaxed text-ink-3">
          Gmail does not report bounces. A dead customer address will fail
          silently and this app will still record the email as sent.
        </p>
      )}
      {data.provider === "smtp" && (
        <p className="mb-4 text-2xs leading-relaxed text-ink-3">
          A plain relay does not report bounces either &mdash; a dead customer
          address will look like a successful send, and the bounce goes to the
          relay&rsquo;s own mailbox. Mail also leaves as the relay&rsquo;s
          address rather than the From below, because a relay may only send as
          the identity it signed in with; your From address becomes the reply-to
          instead. This relay is shared by every workspace on this deployment.
        </p>
      )}


      {/* ── Gmail connection ─────────────────────────────────────────────── */}
      <div className="mb-4 rounded-lg border border-hairline p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">Google account</p>
            {/* Three states, kept distinct because they need different actions:
                connected and ready, connected but missing the send scope, and
                not connected at all. Collapsing the first two into "Not
                connected" told the user to redo work they had already done. */}
            <p className="truncate text-2xs text-ink-3">
              {gmailReady
                ? `${data.gmail.email} · ready to send${data.gmail.isDesignated ? "" : " (not yet selected)"}`
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

        {/* ── Which teammate's account sends ───────────────────────────────────
            PATCH has always accepted a gmailSenderUserId; this card never sent one, so the
            sender stayed whoever configured email FIRST (PATCH derives it as
            `body.gmailSenderUserId || current || the caller`). Reported 22 Aug 2026: mail
            was leaving as pardeep@anutech.in and should leave as sales@anutech.in, and no
            screen could change it. This is the missing half.

            Ineligible teammates are LISTED, not hidden. "sales@ is not in the list" and
            "sales@ has not connected Google" send the operator to different places, and
            only the second was ever true. */}
        {data.canChooseSender && data.senderCandidates.length > 1 && (
          <div className="mt-3 border-t border-hairline pt-3">
            <Label htmlFor="gmail-sender">Send as</Label>
            <select
              id="gmail-sender"
              value={data.gmail.senderId ?? ""}
              onChange={(e) => save.mutate({ provider: "gmail", gmailSenderUserId: e.target.value })}
              disabled={save.isPending}
              className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-2 text-sm text-ink outline-none focus:border-amber disabled:opacity-60"
            >
              {data.senderCandidates.map((c) => (
                <option key={c.userId} value={c.userId} disabled={!c.eligible}>
                  {c.sendsAs ?? c.loginEmail ?? c.userId}
                  {c.sendsAs && c.loginEmail && c.sendsAs !== c.loginEmail ? ` (logs in as ${c.loginEmail})` : ""}
                  {c.eligible ? "" : " — not available"}
                </option>
              ))}
            </select>

            {/* The blockers, named, with who has to act. OAuth belongs to the person: the
                owner cannot connect a teammate's Google for them. */}
            {data.senderCandidates.filter((c) => !c.eligible).length > 0 && (
              <ul className="mt-2 space-y-1">
                {data.senderCandidates.filter((c) => !c.eligible).map((c) => (
                  <li key={c.userId} className="text-2xs leading-relaxed text-ink-3">
                    <span className="font-mono text-ink-2">{c.loginEmail ?? c.userId}</span>{" "}
                    {blockerText(c.blocker!)}
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-2 text-2xs leading-relaxed text-ink-3">
              Mail leaves from the <b>Google address</b> shown here, which is what the
              customer sees — not the workspace login.
            </p>
          </div>
        )}
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
          <p className="mt-1 text-2xs leading-relaxed text-ink-3">
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
              placeholder="Sharma Cloud Solutions"
            />
          </div>
        </div>
        <p className="text-2xs leading-relaxed text-ink-3">
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
