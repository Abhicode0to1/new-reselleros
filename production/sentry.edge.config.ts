/**
 * Sentry — Edge runtime init (middleware + edge API routes).
 *
 * Only initialises when SENTRY_DSN is set.
 */
import * as Sentry from "@sentry/nextjs";
import { redactBreadcrumb } from "@/lib/sentry-redact";

const DSN = process.env.SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn:              DSN,
    environment:      process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    /* ResellerClub authenticates by query string — the fetch instrumentation
       records it, and nothing above this line was filtering it. See
       lib/sentry-redact.ts for the measurement. */
    beforeBreadcrumb: redactBreadcrumb,
  });
}
