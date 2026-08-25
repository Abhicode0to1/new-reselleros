"use client";

/**
 * Authenticated-app error boundary — catches errors thrown inside any
 * page under `(app)/`. The sidebar + topbar from the layout stays
 * rendered around this UI, so the operator still has a way out.
 *
 * Reports to Sentry on mount via the client SDK. The error.digest
 * (when present) is shown so the operator can quote it in a support
 * ticket and we can match it to the Sentry event.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { boundary: "app-error" },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <Icon name="alert" className="h-6 w-6" />
        </div>
        <p className="mb-2 text-2xs uppercase tracking-wider text-ink-3">
          Something went wrong
        </p>
        <h1 className="mb-3 font-serif text-2xl text-ink">
          We hit a snag loading this page.
        </h1>
        <p className="mb-6 text-sm text-ink-2">
          The error has been logged. Try reloading, or head back to the
          dashboard. If it keeps happening, contact{" "}
          <a
            href="mailto:support@resellersos.in"
            className="font-medium text-amber underline-offset-2 hover:underline"
          >
            support@resellersos.in
          </a>
          .
        </p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
          <Button onClick={() => reset()}>Try again</Button>
        </div>
        {error.digest && (
          <p className="mt-6 font-mono text-2xs text-ink-3">
            ref: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
