"use client";

/**
 * The 6-digit authenticator-app code step (R-048 part 2, 4 Oct 2026).
 * Used right after a password sign-in (login page) and on /mfa, where middleware sends a
 * session that has a verified TOTP factor but has not passed it yet (aal1 → aal2).
 */
import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function MfaCodeForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) { setErr("Enter the 6-digit code from your authenticator app."); return; }
    setBusy(true); setErr("");
    const supabase = createClient();
    const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
    const totp = factors?.totp?.find((f) => f.status === "verified");
    if (fErr || !totp) { setBusy(false); setErr("No authenticator is set up on this account."); return; }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code: clean });
    setBusy(false);
    if (error) { setErr("That code did not match. Codes change every 30 seconds — try the current one."); setCode(""); return; }
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label htmlFor="mfa-code" className="block text-sm font-medium text-ink">Authenticator code</label>
      <Input
        id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus
        value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456"
        className="text-center text-lg tracking-[0.3em] tabular-nums"
      />
      {err && <p className="text-sm text-rose-ink" role="alert">{err}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {busy ? "Checking…" : "Verify"}
      </Button>
    </form>
  );
}
