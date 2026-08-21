/**
 * /quotes/[id]/edit — edit a DRAFT quote in place.
 *
 * ─── WHY THIS ROUTE EXISTS ──────────────────────────────────────────────────
 * Two buttons pointed here for a long time — "Edit" on a draft and "Change the pricing"
 * in the approval block — and the route did not, so both returned a 404. They carried
 * `as any` on the href, which silenced the very typedRoutes check that would have caught
 * it. Until now the only working path was "Duplicate & edit", which is right for a quote
 * the customer has seen and wrong for a draft: it leaves the original draft behind, so one
 * unfinished quote becomes two and the ledger carries a number nobody sent.
 *
 * ─── THE GUARD IS THE POINT ─────────────────────────────────────────────────
 * Only a draft may be edited in place. Everything past that has left the building — a
 * sent PDF in the customer's inbox, an accepted price, a recorded payment, an issued tax
 * invoice — and quietly rewriting the row makes the record disagree with reality. The
 * rules and the reasons are in lib/quotes/editable.ts, pure and unit-tested, next to the
 * delete guard that works the same way.
 *
 * The block is enforced HERE rather than only by hiding the button, because a URL is
 * typeable and a link is shareable. And per §24 it is not a dead end: it says which state
 * blocked it, why that matters, and offers the duplicate flow that does work.
 */
"use client";

import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { QuoteBuilder } from "@/components/features/quotes/quote-builder";
import { useQuote } from "@/lib/queries/quotes";
import { quoteEditBlockReason } from "@/lib/quotes/editable";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";

export default function EditQuotePage({ params }: { params: { id: string } }) {
  const { data: quote, isLoading, error } = useQuote(params.id);

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-[1240px] mx-auto">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div className="p-4 sm:p-6 max-w-[1240px] mx-auto">
        <EmptyState
          icon="file"
          title={error ? "Could not load quote" : "Quote not found"}
          body={
            error
              ? "Something went wrong fetching this quote. Try again, or open the quotes list."
              : `No quote with the id ${params.id}.`
          }
          action={
            <Button asChild variant="primary">
              <Link href="/quotes">Back to quotes</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const block = quoteEditBlockReason(quote);
  if (block) {
    return (
      <div className="p-4 sm:p-6 max-w-[820px] mx-auto">
        <Card className="p-5 space-y-4 border-amber/40">
          <div className="flex items-start gap-3">
            <Icon name="alert-triangle" size={18} className="text-amber-ink mt-0.5 shrink-0" />
            <div className="space-y-1.5 min-w-0">
              <h1 className="text-base font-semibold text-ink">
                {quote.id} can&apos;t be edited
              </h1>
              <p className="text-sm text-ink-2">{block.reason}</p>
              <p className="text-sm text-ink-2">{block.nextStep}</p>
            </div>
          </div>
          {/* Both exits are real destinations, not advice. */}
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="primary" icon="copy">
              <Link href={`/quotes/new?duplicate=${quote.id}`}>Duplicate &amp; re-price</Link>
            </Button>
            <Button asChild variant="default" icon="file">
              <Link href={`/quotes/${quote.id}`}>Open {quote.id}</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  /* QuoteBuilder reads the quote id off the pathname and configures itself — including
     reusing this quote's number on save, so the edit replaces the draft instead of
     creating a second one. Suspense because it reads searchParams. */
  return (
    <Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading quote builder…</div>}>
      <QuoteBuilder />
    </Suspense>
  );
}
