"use client";

/**
 * The three support plans, with a Monthly / Yearly switch.
 *
 * ─── THE TOGGLE SWAPS THE SKU, IT DOES NOT DO ARITHMETIC ────────────────────
 * Monthly and Yearly are two different catalogue rows with two different prices,
 * because the yearly price is a DISCOUNT and not twelve monthlies (₹9,990, not
 * ₹11,988 — and ₹9,990 ÷ 12 is not a whole rupee, see lib/support/tiers.ts).
 *
 * So this component never computes a price. It picks the row the tenant's catalogue
 * actually holds and hands its rate to the quote. A component that multiplied or
 * divided here would be a second pricing rule sitting next to the real one.
 *
 * ─── AND THE SAVING IS DERIVED, NOT WRITTEN ON THE BADGE ────────────────────
 * "Save 17% · 2 months free" comes out of annualSaving(), from the two prices. A
 * hardcoded 17% becomes wrong the first time someone edits a price — and it is the
 * kind of wrong that prints on a customer's quote.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, rupee } from "@/lib/utils";
import {
  SUPPORT_TIERS, annualSaving, findSupportSku, supportPrice,
  type SupportTier,
} from "@/lib/support/tiers";
import type { QuoteLineItem, Item } from "@/lib/supabase/database.types";

type Cycle = "monthly" | "yearly";

export interface SupportPlanPickerProps {
  /** The tenant's catalogue, already loaded by the builder. */
  items: readonly Item[];
  /** Add a line to the quote. The builder owns merging and list-price freezing. */
  onAdd: (line: QuoteLineItem) => void;
}

/** What a tier costs on the chosen cycle, expressed the way a quote line wants it. */
function annualRateFor(tier: SupportTier, cycle: Cycle): number {
  /* A quote line's `rate` is the ANNUAL figure whatever the billing frequency
     (database.types.ts:1010). For a monthly plan that is twelve months of it; for a
     yearly plan it is the discounted total, used as-is. */
  return cycle === "yearly" ? tier.annualTotal : supportPrice(tier, "monthly") * 12;
}

export function SupportPlanPicker({ items, onAdd }: SupportPlanPickerProps) {
  const [cycle, setCycle] = React.useState<Cycle>("yearly");

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">Support plan</h3>
          <p className="text-[11px] text-ink-3">Sold alongside the licences, billed on its own cycle.</p>
        </div>

        {/* Two buttons rather than a dropdown: there are exactly two answers and the
            comparison is the point. */}
        <div className="flex rounded-lg border border-hairline p-0.5" role="group" aria-label="Billing cycle">
          {(["monthly", "yearly"] as Cycle[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCycle(c)}
              aria-pressed={cycle === c}
              className={cn(
                "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                cycle === c ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2",
              )}
            >
              {c === "monthly" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {SUPPORT_TIERS.map((tier) => {
          const sku    = findSupportSku(items, tier.id, cycle);
          const saving = annualSaving(tier);
          const rate   = annualRateFor(tier, cycle);
          const isFree = tier.monthly === 0 && tier.annualTotal === 0;

          return (
            <div key={tier.id} className="rounded-lg border border-hairline p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <span aria-hidden>{tier.icon}</span>
                <span className="text-[13px] font-semibold text-ink">{tier.label}</span>
                {cycle === "yearly" && saving && (
                  <Badge kind="success" size="sm">
                    Save {saving.percent}%
                  </Badge>
                )}
              </div>

              <p className="mb-1.5 font-serif text-lg tabular-nums text-ink">
                {isFree ? "Free" : rupee(supportPrice(tier, cycle))}
                {!isFree && (
                  <span className="ml-1 text-[11px] font-sans text-ink-3">
                    {cycle === "yearly" ? "/yr" : "/mo"}
                  </span>
                )}
              </p>

              {cycle === "yearly" && saving && (
                <p className="mb-1.5 text-[11px] text-emerald">
                  {saving.monthsFree} months free · {rupee(saving.rupees)} off {rupee(tier.monthly * 12)}
                </p>
              )}

              <p className="mb-2 text-[11px] leading-snug text-ink-3">{tier.summary}</p>

              <ul className="mb-2.5 space-y-0.5 text-[11px] text-ink-3">
                <li>· First response in {tier.slaHours}h</li>
                <li>
                  ·{" "}
                  {tier.channels.whatsapp === "24x7" ? "WhatsApp, 24/7"
                    : tier.channels.whatsapp === "business_hours" ? "WhatsApp in business hours"
                    : "Email only"}
                </li>
                <li>
                  ·{" "}
                  {tier.channels.meetCallsPerMonth === null ? "Unlimited live calls"
                    : tier.channels.meetCallsPerMonth > 0 ? `${tier.channels.meetCallsPerMonth} live calls a month`
                    : "No live calls"}
                </li>
              </ul>

              {/* A ₹0 plan is not something you put on a quote — there is nothing to
                  invoice, and generate_invoice refuses a zero-value tax invoice. It
                  is what a customer has when they buy nothing. */}
              {isFree ? (
                <p className="text-[11px] italic text-ink-3">
                  Included by default — nothing to add to a quote.
                </p>
              ) : !sku ? (
                /* Never fall back to a price computed here. If the row is missing the
                   catalogue is what needs fixing, and saying so is the next step. */
                <p className="text-[11px] leading-snug text-rose">
                  Not in your catalogue yet. Add it under Catalog &amp; Products, then
                  it can go on a quote.
                </p>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-center"
                  onClick={() => onAdd({
                    id:        `sup-${tier.id}-${cycle}-${Date.now()}`,
                    item_id:   sku.id,
                    name:      sku.name,
                    qty:       1,
                    rate,
                    cost:      0,
                    commitment: cycle === "yearly" ? "annual_yearly" : "monthly",
                  })}
                >
                  Add to quote
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
