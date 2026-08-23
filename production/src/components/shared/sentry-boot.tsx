"use client";

/**
 * Runs the browser Sentry init, once, with the DSN handed down from the server.
 *
 * ─── WHY THE DSN IS A PROP ──────────────────────────────────────────────────
 * The first version read `process.env.NEXT_PUBLIC_SENTRY_DSN` inside the client module,
 * and the browser test page reported `dsnPresent: false` on the first run. `NEXT_PUBLIC_*`
 * is inlined at BUILD time; the DSN had been set as a Cloud Run RUNTIME variable, so it
 * was in neither bundle — and `.env.local` had no such line either, so localhost was
 * equally blind. An event id was minted and nothing left the tab.
 *
 * The root layout is a Server Component, so it reads `process.env.SENTRY_DSN` at request
 * time and passes it here. One variable, no rebuild when it changes, and no way for the
 * build and the runtime to disagree about whether monitoring is on.
 *
 * Mounted in the ROOT layout rather than `(app)/layout.tsx` — that one is `"use client"`
 * and cannot read server env at all, and a crash in `(public)/` or `(auth)/` deserves
 * reporting just as much as one behind the login.
 *
 * Renders nothing. With no DSN the init returns immediately, so this is inert until
 * somebody configures it — no error, no console noise.
 */
import * as React from "react";
import { initClientSentry } from "@/lib/sentry-client";

export function SentryBoot({ dsn }: { dsn: string | null }) {
  React.useEffect(() => {
    initClientSentry(dsn);
  }, [dsn]);
  return null;
}
