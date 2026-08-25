"use client";

/**
 * Proves the BROWSER half of Sentry actually works.
 *
 * ─── WHY THE SERVER SMOKE TEST WAS NOT ENOUGH ───────────────────────────────
 * `/api/sentry-test` proved the server on 23 Aug 2026 — `clientReady=true`,
 * `flushed=true`, event 60ca0aea. That says nothing about the browser: `lib/sentry.ts`
 * reads `SENTRY_DSN` and never runs client-side, so until `lib/sentry-client.ts` landed
 * there was no client init at all, and both error boundaries were calling
 * `captureException` into nothing.
 *
 * That failure is invisible from the outside. A React crash shows the boundary either
 * way; whether an event left the tab is not something the page can tell you. So this
 * asks the SDK directly, and then triggers a real crash so the real path runs.
 *
 * ─── IT THROWS FOR REAL, IN RENDER ──────────────────────────────────────────
 * Not `captureException(new Error(...))` — that would test the transport while skipping
 * the thing being verified, which is that a genuine React render error reaches the
 * boundary and the boundary's report leaves the browser. Throwing during render is what
 * an actual bug does.
 *
 * ─── AND IT IS BEHIND THE SAME DOOR AS EVERYTHING ELSE UNDER /dev ───────────
 * Production serves this only with ALLOW_DEV_PAGES=1; the middleware 404s it otherwise.
 * Worth knowing that until today it would NOT have been: /dev was publicly reachable in
 * production despite CLAUDE.md §7 claiming otherwise, and adding a page that
 * deliberately crashes to a public directory is how you get a crash-on-demand endpoint
 * for strangers.
 */

import * as React from "react";
import * as Sentry from "@sentry/nextjs";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function SentryClientTestPage() {
  const [crash, setCrash] = React.useState(false);
  const [probe, setProbe] = React.useState<{
    clientReady: boolean;
    dsnPresent: boolean;
    eventId: string | null;
    flushed: boolean | null;
  } | null>(null);

  /* Thrown during RENDER, so React's boundary handles it exactly as it would a real bug.
     A throw inside onClick would be swallowed by the event handler instead. */
  if (crash) {
    throw new Error(
      `ResellerOS BROWSER Sentry test ${new Date().toISOString()} — intentional, no action needed`,
    );
  }

  /**
   * The three facts that separate "configured" from "working", read from the SDK rather
   * than inferred. `flushed === false` is the tell CLAUDE.md §22 describes: an event id
   * is minted locally and the transport never runs.
   */
  async function runProbe() {
    const eventId = Sentry.captureMessage("ResellerOS browser Sentry probe — intentional");
    const flushed = await Sentry.flush(3000);
    setProbe({
      clientReady: Boolean(Sentry.getClient()),
      /* Asked of the CLIENT, not of process.env. The first version read
         NEXT_PUBLIC_SENTRY_DSN here and reported dsnPresent:false — correctly, because
         that variable is inlined at build time and the DSN is a runtime one. What matters
         is whether the SDK ended up with a DSN, which only the client knows. */
      dsnPresent: Boolean(Sentry.getClient()?.getOptions().dsn),
      eventId: eventId ?? null,
      flushed,
    });
  }

  return (
    <div className="mx-auto max-w-[720px] p-6 space-y-4">
      <div>
        <p className="text-2xs uppercase tracking-wider text-ink-3">Dev · monitoring</p>
        <h1 className="font-serif text-2xl text-ink">Browser Sentry test</h1>
        <p className="mt-1 text-sm text-ink-2">
          The server half was proven with <code className="font-mono text-[12px]">/api/sentry-test</code>.
          This proves the browser half, which is a different SDK, a different DSN variable and a
          different init.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">1. Ask the SDK</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">
            Sends a message event and reports whether the transport actually drained.
            <b> flushed: false</b> means the event was created and went nowhere — which looks
            identical to working from anywhere else.
          </p>
        </div>
        <Button variant="default" onClick={() => void runProbe()}>Run probe</Button>

        {probe && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-hairline bg-paper-2 p-3 font-mono text-[12px]">
            <dt className="text-ink-3">dsnPresent</dt>
            <dd className={probe.dsnPresent ? "text-ink" : "text-rose"}>{String(probe.dsnPresent)}</dd>
            <dt className="text-ink-3">clientReady</dt>
            <dd className={probe.clientReady ? "text-ink" : "text-rose"}>{String(probe.clientReady)}</dd>
            <dt className="text-ink-3">flushed</dt>
            <dd className={probe.flushed ? "text-ink" : "text-rose"}>{String(probe.flushed)}</dd>
            <dt className="text-ink-3">eventId</dt>
            <dd className="text-ink break-all">{probe.eventId ?? "(none)"}</dd>
          </dl>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">2. Crash the page for real</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">
            Throws during render, so React&apos;s boundary handles it the way it handles a genuine
            bug — and the boundary&apos;s own <code className="font-mono">captureException</code> is
            what gets exercised. That call is the one that has been going nowhere.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCrash(true)}>
          Crash this page
        </Button>
        <p className="text-2xs leading-relaxed text-ink-3">
          Expect the &ldquo;We hit a snag&rdquo; screen. Then look in Sentry for
          <b> ResellerOS BROWSER Sentry test</b> — if it is there, the browser half works.
        </p>
      </Card>
    </div>
  );
}
