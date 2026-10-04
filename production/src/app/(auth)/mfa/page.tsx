"use client";

/**
 * /mfa — second step for an account with two-factor sign-in on (R-048 part 2).
 * Middleware sends a signed-in-but-unverified (aal1) session here from any app page.
 */
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { MfaCodeForm } from "@/components/features/auth/mfa-code-form";
import { appPathOr } from "@/lib/safe-path";

export default function MfaPage() {
  return (
    <React.Suspense fallback={null}>
      <MfaStep />
    </React.Suspense>
  );
}

function MfaStep() {
  const next = appPathOr(useSearchParams().get("next"));
  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Two-step sign-in</h1>
        <p className="text-sm text-ink-3">Open your authenticator app and enter the 6-digit code for ResellerOS.</p>
      </div>
      {/* Hard navigation so the upgraded (aal2) session cookie reaches the next request. */}
      <MfaCodeForm onDone={() => { window.location.href = next; }} />
      <form action="/auth/sign-out" method="post" className="mt-5 text-center">
        <button type="submit" className="text-sm text-ink-3 hover:underline">Use a different account</button>
      </form>
    </Card>
  );
}
