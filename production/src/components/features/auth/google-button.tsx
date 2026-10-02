/**
 * "Continue with Google" — one button for login AND signup (R-102, 2 Oct 2026).
 *
 * Signup had only email + password while login had Google. The flow is the same for
 * both: Supabase OAuth → /callback. An existing person lands on `next`; a new one, with
 * no company yet, is sent to /welcome by the callback to create or join one — so a
 * separate "Google signup" path is not needed, only the button.
 *
 * R-098: ask Supabase first whether Google is on. With it off (every local setup) the
 * redirect lands on raw JSON — "provider is not enabled" — and the person is stuck.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { isOAuthProviderEnabled } from "@/lib/auth/oauth-enabled";

export function GoogleAuthButton({
  label,
  nextPath,
  disabled,
}: {
  label: string;
  /** Where an existing user goes after the callback. */
  nextPath: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const enabled = await isOAuthProviderEnabled(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "google");
      if (enabled === false) {
        toast.error("Google sign-in isn't turned on here.", { description: "Use your email and password below." });
        return;
      }
      const { error } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/callback?next=${encodeURIComponent(nextPath)}` },
      });
      if (error) toast.error("Could not open Google", { description: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" className="w-full justify-center" onClick={onClick} disabled={disabled} loading={busy}>
      <GoogleLogo />
      {label}
    </Button>
  );
}

function GoogleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC04" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
