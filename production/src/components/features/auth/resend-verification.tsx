"use client";

/**
 * "Send me a new confirmation link" (R-048). Used on /verify-email, after signup, and on the
 * login screen when GoTrue answers "Email not confirmed". The server always answers the same
 * way, so the message here never reveals whether an account exists.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ResendVerification({ initialEmail = "" }: { initialEmail?: string }) {
  const [email, setEmail] = React.useState(initialEmail);
  const [state, setState] = React.useState<"idle" | "sending" | "sent">("idle");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("sending");
    await fetch("/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    }).catch(() => null);
    setState("sent");
  }

  if (state === "sent") {
    return (
      <p className="text-sm text-ink-2 text-center" role="status">
        If <b>{email}</b> has an unconfirmed account, a new link is on its way. Check spam too.
      </p>
    );
  }
  return (
    <form onSubmit={send} className="space-y-3">
      <label className="block text-xs font-medium text-ink-2" htmlFor="resend-email">Your email</label>
      <Input id="resend-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      <Button type="submit" variant="primary" className="w-full" disabled={state === "sending"}>
        {state === "sending" ? "Sending…" : "Send a new confirmation link"}
      </Button>
    </form>
  );
}
