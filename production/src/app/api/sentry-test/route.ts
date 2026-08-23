/**
 * GET /api/sentry-test
 *
 * Dev/staging utility — throws a server-side error so we can verify Sentry
 * captures it. Disabled in production builds unless ALLOW_SENTRY_TEST=1.
 *
 * Usage:
 *   curl -i https://<host>/api/sentry-test
 *   → 500, error appears in Sentry within ~10 seconds
 */
import { NextResponse } from "next/server";
import "@/lib/sentry"; // side-effect import — guarantees Sentry init on Cloud Run
import * as Sentry from "@sentry/nextjs";

export const runtime = "nodejs";

export async function GET() {
  if (process.env.NODE_ENV === "production" && !process.env.ALLOW_SENTRY_TEST) {
    return NextResponse.json(
      { error: "sentry-test disabled in production. Set ALLOW_SENTRY_TEST=1 to enable temporarily." },
      { status: 403 },
    );
  }

  const err = new Error(
    `ResellerOS Sentry smoke test ${new Date().toISOString()} — intentional, no action needed`,
  );
  const eventId = Sentry.captureException(err, {
    tags: { test: "sentry-smoke", source: "/api/sentry-test" },
  });
  // Flush ensures the event leaves the process before we throw (otherwise
  // Cloud Run might kill the worker before the HTTP POST to Sentry completes).
  const flushed = await Sentry.flush(2000);

  /* ── Report the OUTCOME, not just the attempt ──────────────────────────────
     Added 23 Aug 2026, wiring the DSN for the first time. This route threw a 500 and
     logged the error, and both of those happen identically whether Sentry received
     anything or not — which is the precise failure §22 exists to describe:
     `captureException` mints an event id locally and `flush()` returns FALSE when no
     transport was ever initialised.

     So a 500 from here was never evidence. These three facts are:
       clientReady  is there an initialised client at all (the §22 symptom)
       eventId      the id to search for in Sentry, so "did it arrive" is checkable
       flushed      did the transport actually drain — false means it went nowhere

     Logged rather than returned, because this route's contract is to throw. */
  console.info(
    `[sentry-test] clientReady=${Boolean(Sentry.getClient())} eventId=${eventId ?? "(none)"} flushed=${flushed}`,
  );

  throw err;
}
