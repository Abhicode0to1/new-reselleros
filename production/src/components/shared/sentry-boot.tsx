"use client";

/**
 * Runs the browser Sentry init, once, as early as the app tree allows.
 *
 * A component rather than a bare import because `initClientSentry` must run in the
 * browser and Next.js would otherwise evaluate the module during the server render of
 * whatever imported it. Mounted from `(app)/layout.tsx` — the same chokepoint reasoning
 * as `lib/supabase/server.ts` on the server side (CLAUDE.md §22): put the init where
 * every path already goes, rather than asking each new file to remember.
 *
 * Renders nothing. If `NEXT_PUBLIC_SENTRY_DSN` is unset the init returns immediately, so
 * this is inert until somebody configures it — no error, no console noise, and the app
 * behaves exactly as it does today.
 */
import * as React from "react";
import { initClientSentry } from "@/lib/sentry-client";

export function SentryBoot() {
  React.useEffect(() => {
    initClientSentry();
  }, []);
  return null;
}
