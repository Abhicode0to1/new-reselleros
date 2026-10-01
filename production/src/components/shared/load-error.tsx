"use client";

/**
 * When a money screen's query fails, the page must say so — not fall through to
 * `data ?? []` and print ₹0, which reads as "you have nothing" (S32, 1 Oct 2026).
 *
 * - `<LoadError>`: replaces the screen's content (one query feeds the whole page).
 * - `<LoadErrorBanner>`: sits above content built from several queries (dashboard),
 *   warning that the figures below are incomplete until they load.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/shared/empty-state";

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card className="py-2">
      <EmptyState
        icon="alert"
        title={`${what} didn't load`}
        body="Your data is safe, it just couldn't be fetched. Check the connection and try again."
        action={<Button variant="primary" icon="refresh" onClick={onRetry}>Try again</Button>}
      />
    </Card>
  );
}

export function LoadErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose/40 bg-rose/5 px-4 py-3">
      <div className="flex items-start gap-2 text-sm">
        <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-rose" />
        <span>
          <b className="text-ink">Some numbers didn't load.</b>{" "}
          <span className="text-ink-2">Amounts below may show ₹0 until they do. Your data is safe.</span>
        </span>
      </div>
      <Button size="sm" icon="refresh" onClick={onRetry}>Try again</Button>
    </div>
  );
}
