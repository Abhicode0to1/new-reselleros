/**
 * Sentry — browser client init.
 *
 * Runs once on the client side at app boot. Only initialises when
 * NEXT_PUBLIC_SENTRY_DSN is set — so local dev without the DSN stays
 * silent (no errors flooded to Sentry, no setup friction).
 */
import * as Sentry from "@sentry/nextjs";
import { redactBreadcrumb } from "@/lib/sentry-redact";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn:                  DSN,
    environment:          process.env.NODE_ENV,
    tracesSampleRate:     process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,    // No session replay (privacy + cost)
    replaysOnErrorSampleRate: 0.1,  // Capture 10% of error sessions only
    /* Same rule as the server. The browser never calls ResellerClub, but a
       credential in a query string is not a ResellerClub-only shape, and one
       rule in one file cannot drift between five copies. */
    beforeBreadcrumb: redactBreadcrumb,
    ignoreErrors: [
      // Common browser noise we don't care about
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
    ],
  });
}
