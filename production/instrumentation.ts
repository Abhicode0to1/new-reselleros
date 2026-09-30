/**
 * Next.js instrumentation hook — THE Sentry server + edge init.
 *
 * Next 15 always loads this file and calls `register()` once per runtime at server
 * boot (the `experimental.instrumentationHook` flag is gone — see next.config). This is
 * the setup @sentry/nextjs v10 documents: import the runtime's config from `register()`
 * and export `onRequestError = captureRequestError`. No SENTRY_DSN → nothing is imported
 * and nothing initialises (local dev, CI builds).
 *
 * History: on Next 14.2.15 standalone (verified 2026-05-29) this hook did NOT fire on
 * Cloud Run, so init was bolted on via `import "@/lib/sentry"` (chokepoint:
 * lib/supabase/server.ts). That import stays as belt-and-braces; it and both configs are
 * guarded by `Sentry.getClient()`, so whichever runs first wins and the rest are no-ops.
 * /api/sentry-test no longer imports it, so its `clientReady=` log line now proves that
 * THIS hook initialised Sentry.
 */
export async function register() {
  if (!process.env.SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Optional: wire up Sentry to receive React Server Component errors.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
