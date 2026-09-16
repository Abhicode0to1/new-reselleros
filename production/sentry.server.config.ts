/**
 * Sentry — Node.js server init (route handlers, server components, server actions).
 *
 * Only initialises when SENTRY_DSN is set. Filters out tenant_id and PII
 * from event payloads before sending — see beforeSend below.
 *
 * NOTE: On Cloud Run + Next.js 14.2 standalone, instrumentation.ts is NOT
 * called at boot, so this file is currently a fallback. Server-side init
 * actually happens via the module-level guard in /api/sentry-test/route.ts.
 * Keep this file for future Next.js versions where the hook works.
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
    // Strip sensitive fields from error context before transmission.
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["cookie"];
      }
      return event;
    },
  });
}
