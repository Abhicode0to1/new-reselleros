/**
 * Server-side Sentry initialiser — workaround for Next.js 14.2 standalone
 * mode on Cloud Run, where `instrumentation.ts` `register()` does not fire
 * at boot (verified 2026-05-29). Without init, captureException creates
 * event IDs locally but the transport never runs, so events silently drop.
 *
 * Import this module from any server-side file that wants Sentry to be
 * guaranteed-initialised (route handlers, server actions, cron handlers).
 * The init is module-level and idempotent — re-imports are free.
 *
 * Usage:
 *   import "@/lib/sentry";  // side-effect import, init runs once
 *   import * as Sentry from "@sentry/nextjs";
 *   Sentry.captureException(err);
 *
 * When Next.js fixes the standalone instrumentation issue, this file can
 * be deleted and replaced with the canonical instrumentation.ts approach.
 */
import * as Sentry from "@sentry/nextjs";
import { redactBreadcrumb } from "./sentry-redact";

const DSN = process.env.SENTRY_DSN;

if (DSN && !Sentry.getClient()) {
  Sentry.init({
    dsn:              DSN,
    environment:      process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    /* ResellerClub authenticates by query string — the fetch instrumentation
       records it, and nothing above this line was filtering it. See
       lib/sentry-redact.ts for the measurement. */
    beforeBreadcrumb: redactBreadcrumb,
    beforeSend(event) {
      // Strip credentials that may have leaked into request context.
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["cookie"];
      }
      return event;
    },
  });
}

export { Sentry };
