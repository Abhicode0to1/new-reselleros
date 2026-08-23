"use client";

/**
 * "What this will do", above an irreversible button.
 *
 * ─── WHY A COMPONENT AND NOT THREE COPIES ───────────────────────────────────
 * Three acts need it — issuing an invoice, sending a quote, recording a payment — and
 * the markup is identical. What must NOT be shared is the wording: each list comes from
 * its own pure module (`lib/invoices/issue-consequences`, `lib/quotes/send-consequences`,
 * `lib/payments/record-consequences`), computed from that act's own data and unit-tested
 * there. This file only decides how a fact and a warning look.
 *
 * ─── THE POINT IS INFORMATION, NOT FRICTION ─────────────────────────────────
 * A confirmation that says "Are you sure?" adds a click and no facts, and gets clicked
 * through. These lists exist so the operator can spot a WRONG action because of what it
 * says — the number about to be consumed, the figure about to reach a customer, the
 * subscription about to start billing. If a line here could be written without reading
 * the row, it should not be here.
 */

import * as React from "react";

import { Icon } from "@/components/ui/icon";
import type { Consequence } from "@/lib/actions/consequence";

export function ConsequenceList({
  items,
  className,
}: {
  items: readonly Consequence[];
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <ul className={className ?? "space-y-2"}>
      {items.map((c, i) => (
        <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed">
          <Icon
            name={c.tone === "warning" ? "alert" : "info"}
            size={14}
            className={c.tone === "warning" ? "text-amber mt-0.5 shrink-0" : "text-ink-3 mt-0.5 shrink-0"}
          />
          {/* A warning gets the stronger ink. Colour alone never carries the meaning —
              the icon differs too, and the sentence says which it is. */}
          <span className={c.tone === "warning" ? "text-ink" : "text-ink-2"}>{c.text}</span>
        </li>
      ))}
    </ul>
  );
}
