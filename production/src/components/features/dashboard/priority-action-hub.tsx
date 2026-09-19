"use client";

import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";

interface PriorityActionHubProps {
  expiringRenewalsCount: number;
  expiringRenewalsValue: number;
  draftQuotesCount: number;
  pendingCollectValue: number;
}

export function PriorityActionHub({
  expiringRenewalsCount,
  expiringRenewalsValue,
  draftQuotesCount,
  pendingCollectValue,
}: PriorityActionHubProps) {
  return (
    <div className="space-y-4 mb-6">
      {/* Priority Action Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Renewals Attention */}
        <Card className="p-4 border-amber/30 bg-gradient-to-br from-amber/10 via-amber/5 to-transparent relative overflow-hidden shadow-xs">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Badge kind="warning" size="sm" dot>Attention Needed</Badge>
              <h4 className="text-sm font-semibold text-foreground mt-2">
                {expiringRenewalsCount > 0
                  ? `${expiringRenewalsCount} Renewals Expiring Soon`
                  : "No Urgent Renewals"}
              </h4>
              <p className="text-xs text-muted-foreground">
                {expiringRenewalsCount > 0
                  ? `Value at risk: ${rupee(expiringRenewalsValue)}. Send reminders before grace period.`
                  : "All subscription renewals are up to date for the next 30 days."}
              </p>
            </div>
            <div className="h-10 w-10 rounded-full bg-amber/15 text-amber-ink grid place-items-center shrink-0">
              <Icon name="clock" size={20} />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-amber/20 pt-3">
            <span className="text-2xs font-medium text-muted-foreground">
              Auto-cadence active
            </span>
            <Button asChild size="sm" variant="outline" className="h-7 text-xs border-amber/30 hover:bg-amber/10">
              <Link href="/renewals">
                View Renewals <Icon name="chevron_right" size={14} className="ml-1" />
              </Link>
            </Button>
          </div>
        </Card>

        {/* Card 2: Quotes to Send */}
        <Card className="p-4 border-indigo/30 bg-gradient-to-br from-indigo/10 via-indigo/5 to-transparent relative overflow-hidden shadow-xs">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Badge kind="info" size="sm" dot>Drafts &amp; Pending</Badge>
              <h4 className="text-sm font-semibold text-foreground mt-2">
                {draftQuotesCount > 0
                  ? `${draftQuotesCount} Draft Quotes to Finalize`
                  : "Quotes Pipeline Active"}
              </h4>
              <p className="text-xs text-muted-foreground">
                {draftQuotesCount > 0
                  ? "Send finalized GST quotes to customers to close deals faster."
                  : "Create new quotes with Google, Microsoft or Zoho templates."}
              </p>
            </div>
            <div className="h-10 w-10 rounded-full bg-indigo/15 text-indigo-ink grid place-items-center shrink-0">
              <Icon name="file" size={20} />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-indigo/20 pt-3">
            <span className="text-2xs font-medium text-muted-foreground">
              Quote Builder
            </span>
            <Button asChild size="sm" variant="outline" className="h-7 text-xs border-indigo/30 hover:bg-indigo/10">
              <Link href="/quotes">
                Open Quotes <Icon name="chevron_right" size={14} className="ml-1" />
              </Link>
            </Button>
          </div>
        </Card>

        {/* Card 3: Receivables & Payments */}
        <Card className="p-4 border-emerald/30 bg-gradient-to-br from-emerald/10 via-emerald/5 to-transparent relative overflow-hidden shadow-xs">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Badge kind="success" size="sm" dot>Collections</Badge>
              <h4 className="text-sm font-semibold text-foreground mt-2">
                {pendingCollectValue > 0
                  ? `${rupee(pendingCollectValue)} Outstanding Owed`
                  : "All Invoices Settled"}
              </h4>
              <p className="text-xs text-muted-foreground">
                {pendingCollectValue > 0
                  ? "Send payment reminders or record received bank payments."
                  : "No pending receivables across active customer accounts."}
              </p>
            </div>
            <div className="h-10 w-10 rounded-full bg-emerald/15 text-emerald-ink grid place-items-center shrink-0">
              <Icon name="rupee" size={20} />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-emerald/20 pt-3">
            <span className="text-2xs font-medium text-muted-foreground">
              Payments Hub
            </span>
            <Button asChild size="sm" variant="outline" className="h-7 text-xs border-emerald/30 hover:bg-emerald/10">
              <Link href="/payments">
                View Payments <Icon name="chevron_right" size={14} className="ml-1" />
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
