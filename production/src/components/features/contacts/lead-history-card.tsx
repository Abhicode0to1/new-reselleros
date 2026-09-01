/**
 * Ek insaan ki LEADS — contact aur customer dono pages par wahi card
 * (1 Sep 2026, Pardeep: "jaise quotation/invoice dikhate hain, waise us
 * contact ki leads bhi").
 *
 * Junk-leads yahan bhi chhupti hain — wahi niyam jo /leads aur contacts-book
 * ka hai; ek jagah dikha dena teeno ko jhoothla deta.
 */
"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee, formatDate } from "@/lib/utils";
import { useLeadsForPerson } from "@/lib/queries/leads";

const STAGE_KIND: Record<string, "muted" | "info" | "warning" | "success" | "danger"> = {
  new: "info", contact: "info", demo: "warning", trial: "warning",
  quote: "warning", won: "success", lost: "danger",
};

export function LeadHistoryCard({
  contactId, emails, phones,
}: {
  contactId?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
}) {
  const { data: leads, isLoading } = useLeadsForPerson({ contactId, emails, phones });
  const visible = (leads ?? []).filter((l) => !l.is_junk);

  if (isLoading) {
    return (
      <Card className="p-4">
        <Skeleton className="h-5 w-24 mb-3" />
        <Skeleton className="h-10 w-full" />
      </Card>
    );
  }
  if (visible.length === 0) return null; // khaali card shor hai — jaisa money-health ka niyam

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
          <Icon name="target" size={15} className="text-ink-3" />
          Leads <span className="text-ink-3 font-normal">({visible.length})</span>
        </h2>
        <Link href={"/leads" as never} className="text-xs text-ink-3 underline hover:text-ink">
          Sab leads
        </Link>
      </div>
      <ul className="divide-y divide-hairline">
        {visible.map((l) => (
          <li key={l.id}>
            <Link
              href={`/leads?lead=${l.id}` as never}
              className="flex items-center justify-between gap-3 py-2.5 hover:bg-paper-2/50 rounded-md px-2 -mx-2 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm text-ink truncate" title={l.company}>{l.company}</p>
                <p className="text-2xs text-ink-3">
                  {formatDate(l.created_at)}
                  {l.plan ? ` · ${l.plan}` : ""}
                  {l.seats ? ` · ${l.seats} seats` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {l.value ? <span className="text-xs tabular-nums text-ink-2">{rupee(l.value, { compact: true })}</span> : null}
                <Badge kind={STAGE_KIND[l.stage] ?? "muted"} size="sm">{l.stage}</Badge>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
