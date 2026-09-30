/**
 * Sentry — Edge runtime init (middleware + edge API routes).
 *
 * Only initialises when SENTRY_DSN is set.
 */
import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN;

if (DSN && !Sentry.getClient()) {
  Sentry.init({
    dsn:              DSN,
    environment:      process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });
}
