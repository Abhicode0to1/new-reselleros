"use client";

/**
 * Search and watch, side by side, sharing one piece of state.
 *
 * The two belong together: a search that comes back TAKEN has exactly one useful
 * next step, and it is the watch box directly below it. Without something
 * holding both, "Watch it" could only tell the customer to scroll down and type
 * the name again — which is the navigation this page was asked to remove.
 *
 * The page itself is a server component and cannot hold the state, so this thin
 * client wrapper does. It renders nothing of its own.
 *
 * The counter matters: clicking "Watch it" on the SAME domain twice must fill
 * the box both times. Keying the effect on the value alone would make the second
 * click do nothing, because the value never changed.
 */

import * as React from "react";
import { DomainSearch } from "./domain-search";
import { DomainWatches, type WatchRowView } from "./domain-watches";

export function DomainTools({
  initialWatches,
  limit,
}: {
  initialWatches: WatchRowView[];
  limit: number;
}) {
  const [prefill, setPrefill] = React.useState({ value: "", nonce: 0 });

  return (
    <>
      <DomainSearch onWatch={(domain) => setPrefill((p) => ({ value: domain, nonce: p.nonce + 1 }))} />
      <DomainWatches initial={initialWatches} limit={limit} prefill={prefill} />
    </>
  );
}
