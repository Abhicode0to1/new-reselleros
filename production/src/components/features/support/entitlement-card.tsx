"use client";

/**
 * What this customer's support actually covers.
 *
 * One component, used on the customer profile and beside a support ticket, because
 * the answer has to be the same in both places. Two implementations of "are they
 * covered?" would eventually disagree, and the disagreement would surface as a rep
 * promising something the profile denies.
 *
 * ─── A SUPPORT SUBSCRIPTION IS MATCHED TO ITS SKU BY NAME ───────────────────
 * `subscriptions` has no item id — the plan is stored as text. So the link back to
 * `items.covered_product` is a name match, and a subscription whose plan name is not
 * in the catalogue comes back with covered = null.
 *
 * That is deliberate rather than unfortunate: null is UNKNOWN, and the card says
 * which plan needs classifying. The alternative — assuming an unmatched plan covers
 * everything — would tell a customer they are entitled to support for a product
 * nobody sold them.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { supportTier, tierFromPlanName } from "@/lib/support/tiers";
import {
  entitlementRows, entitlementSummary, coverageFor, productLabel, detectTicketProduct,
  type SupportCoverage, type LicenceHolding, type CoverageVerdict,
} from "@/lib/support/entitlement";

interface Loaded {
  licences: LicenceHolding[];
  supports: SupportCoverage[];
}

function useEntitlement(customerId: string | null) {
  return useQuery({
    queryKey: ["entitlement", customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<Loaded> => {
      const supabase = createClient();

      /* RLS scopes both reads to the tenant. */
      const { data: subs, error: sErr } = await supabase
        .from("subscriptions")
        .select("id, plan, vendor, seats, status")
        .eq("customer_id", customerId!)
        .eq("status", "active");
      if (sErr) throw sErr;

      const { data: items, error: iErr } = await supabase
        .from("items")
        .select("name, covered_product")
        .eq("vendor", "support");
      if (iErr) throw iErr;

      const coveredByName = new Map(
        (items ?? []).map((i) => [i.name.trim().toLowerCase(), i.covered_product]),
      );

      const licences: LicenceHolding[] = [];
      const supports: SupportCoverage[] = [];

      for (const s of subs ?? []) {
        if (s.vendor === "support") {
          supports.push({
            subscriptionId: s.id,
            planName: s.plan,
            tier: tierFromPlanName(s.plan),
            /* Undefined (no such SKU) collapses to null — both mean "not recorded". */
            covered: coveredByName.get(s.plan.trim().toLowerCase()) ?? null,
          });
        } else {
          licences.push({ subscriptionId: s.id, plan: s.plan, vendor: s.vendor, seats: s.seats ?? 0 });
        }
      }

      /* Best tier first, so a customer holding two plans is reported under the one
         they pay more for (see coverageFor). */
      const RANK = { enterprise: 3, standard: 2, free: 1 } as const;
      supports.sort((a, b) => RANK[b.tier] - RANK[a.tier]);

      return { licences, supports };
    },
  });
}

function VerdictBadge({ v }: { v: CoverageVerdict }) {
  if (v.state === "covered") return <Badge kind="success" size="sm">Covered</Badge>;
  if (v.state === "unknown") return <Badge kind="muted"   size="sm">Not recorded</Badge>;
  return <Badge kind="danger" size="sm">Not covered</Badge>;
}

export interface EntitlementCardProps {
  customerId: string | null;
  /** A ticket's subject + body. The product is detected HERE, against the licences
   *  this component already loaded — detection needs to know what the customer
   *  actually holds, and the caller does not. */
  ticketText?: string | null;
  /** Where the upsell button goes. */
  customerName?: string | null;
}

export function EntitlementCard({ customerId, ticketText, customerName }: EntitlementCardProps) {
  const { data, isLoading, error } = useEntitlement(customerId);

  if (!customerId) {
    return (
      <Card title="Support entitlement">
        <p className="text-sm text-ink-3">
          This is not linked to a customer, so there is no plan to check it against.
        </p>
      </Card>
    );
  }

  if (isLoading) {
    return <Card title="Support entitlement"><Skeleton className="h-24 w-full" /></Card>;
  }
  if (error || !data) {
    return (
      <Card title="Support entitlement">
        <p className="text-sm text-rose">{(error as Error)?.message ?? "Could not load this customer's plans."}</p>
      </Card>
    );
  }

  const rows    = entitlementRows(data.licences, data.supports);
  const summary = entitlementSummary(rows);
  const best    = data.supports[0] ?? null;
  const tier    = best ? supportTier(best.tier) : supportTier("free");

  /* The ticket's own product, judged first — it is the question the rep has now.
     Detection returns null when nothing in the text matches a licence they hold, and
     then no verdict is shown at all: a guess here would raise an uncovered warning
     over a product the customer never mentioned. */
  const ticketVendor  = ticketText ? detectTicketProduct(ticketText, data.licences) : null;
  const ticketVerdict = ticketVendor ? coverageFor(ticketVendor, data.supports) : null;

  const upsellHref = `/quotes/new?company=${encodeURIComponent(customerName ?? "")}` as Route;

  return (
    <Card
      title="Support entitlement"
      sub={best ? best.planName : "No support plan on this account"}
    >
      {/* The plan, its SLA and whether live calls are included. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge kind={tier.alert} size="sm">{tier.icon} {tier.label}</Badge>
        <span className="text-[12px] text-ink-3">First response in {tier.slaHours}h</span>
        <span className="text-[12px] text-ink-3">·</span>
        <span className="text-[12px] text-ink-3">
          {tier.channels.meetCallsPerMonth === null ? "Unlimited live calls"
            : tier.channels.meetCallsPerMonth > 0 ? `${tier.channels.meetCallsPerMonth} live calls a month`
            : "No live calls"}
        </span>
      </div>

      {/* ── The product this ticket is about ─────────────────────────────── */}
      {ticketVerdict && (
        <div className={`mb-3 rounded-lg px-3 py-2.5 ${
          ticketVerdict.state === "covered" ? "bg-emerald-soft"
            : ticketVerdict.state === "unknown" ? "bg-paper-2" : "bg-rose-soft"
        }`}>
          <div className="flex items-center gap-2">
            <VerdictBadge v={ticketVerdict} />
            <span className="text-[13px] font-medium text-ink">{productLabel(ticketVendor)}</span>
          </div>
          {ticketVerdict.state !== "covered" && (
            <>
              <p className="mt-1 text-[12px] leading-snug text-ink-2">{ticketVerdict.reason}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{ticketVerdict.nextStep}</p>
              {/* Offered only when they genuinely are not covered. Showing it on an
                  UNKNOWN would put an upsell in front of a customer who may already
                  have paid for exactly this. */}
              {ticketVerdict.state === "uncovered" && (
                <Button size="sm" className="mt-2" asChild>
                  <Link href={upsellHref}>Quote a support plan</Link>
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Everything they hold ─────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-3">No active product licences on this account.</p>
      ) : (
        <>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
            Licences · {summary.covered} of {summary.total} covered
            {summary.unknown > 0 && ` · ${summary.unknown} not recorded`}
          </p>
          <ul className="divide-y divide-hairline">
            {rows.map(({ licence, verdict }) => (
              <li key={licence.subscriptionId} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-ink">{licence.plan}</p>
                  <p className="text-2xs text-ink-3">
                    {licence.seats} {licence.seats === 1 ? "seat" : "seats"} · {productLabel(licence.vendor)}
                  </p>
                  {verdict.state !== "covered" && (
                    <p className="mt-0.5 text-2xs leading-snug text-ink-3">{verdict.reason}</p>
                  )}
                </div>
                <VerdictBadge v={verdict} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
