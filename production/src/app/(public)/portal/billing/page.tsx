/**
 * /portal/billing — what the customer will be charged, and when.
 *
 * ─── WHAT MAKES THIS A PAGE RATHER THAN A FOURTH COPY ───────────────────────
 * The portal already answers most billing questions: /portal/dashboard shows the
 * active plan and the renewal countdown, /portal/subscription manages seats and
 * auto-renew, /portal/invoices lists issued GST invoices. Adding a page that repeats
 * those would be the same duplication this codebase keeps paying for.
 *
 * The one thing NONE of them answers is the question customers actually ask: "what
 * is my next bill, for how much, and when?" Every existing page looks backwards at
 * what has been invoiced or sideways at what is active. This looks FORWARD, using
 * the schedule engine from lib/billing/schedule.ts.
 *
 * ─── IT SHOWS A SCHEDULE, NOT INVOICES ──────────────────────────────────────
 * Nothing here exists in the invoices table. A tax invoice takes a number from the
 * GST series when it is raised, on its own date (CLAUDE.md §17a) — so these are
 * amounts the customer WILL be billed, and the page says so rather than letting them
 * read a forecast as a document.
 *
 * ─── AND IT NEVER SHOWS COST OR MARGIN ──────────────────────────────────────
 * The select below takes only what a customer may see. Everything passed into this
 * page is serialised into their browser, so `mrr` is the price they pay and no cost
 * column is fetched at all.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { subscriptionSchedule, nextTermSchedule } from "@/lib/billing/subscription-schedule";
import { scheduleTotal } from "@/lib/billing/schedule";
import { cycleScheduleLabel } from "@/lib/quotes/billing";
import { localDateISO } from "@/lib/leads/outcomes";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Billing",
  robots: "noindex",
};

export default async function PortalBillingPage() {
  const session = await requirePortalSession();
  const supabase = createClient();

  /* RLS scopes this to the customer's own rows. No cost columns are selected —
     see the header. */
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("id, plan, vendor, seats, mrr, start_date, renewal_date, status, billing_cycle, term_months, outstanding_amount")
    .eq("status", "active")
    .order("renewal_date", { ascending: true });

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, amount, status, invoice_date, due_date")
    .order("invoice_date", { ascending: false })
    .limit(5);

  const today = localDateISO(new Date());
  const active = subs ?? [];
  const outstanding = active.reduce((s, x) => s + (x.outstanding_amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl text-ink">Billing</h1>
        <p className="text-sm text-ink-3 mt-0.5">
          What {session.tenantName} will charge you, and when.
        </p>
      </div>

      {outstanding > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-ink-3">Outstanding now</p>
              <p className="font-serif text-2xl font-semibold text-rose tabular-nums">{rupee(outstanding)}</p>
            </div>
            <Link
              href="/portal/invoices"
              className="rounded-md border border-hairline bg-paper px-3 py-2 text-xs font-semibold text-ink hover:bg-paper-2"
            >
              See invoices
            </Link>
          </div>
        </Card>
      )}

      {active.length === 0 && (
        <Card>
          <p className="text-sm text-ink-3">
            No active subscriptions, so there is nothing scheduled. Anything already
            issued is on your <Link href="/portal/invoices" className="font-medium text-ink underline">invoices</Link> page.
          </p>
        </Card>
      )}

      {active.map((sub) => {
        const current = subscriptionSchedule(sub);
        const next = nextTermSchedule(sub);
        const upcoming = [...current, ...next].filter((p) => p.billOn >= today).slice(0, 4);

        return (
          <Card
            key={sub.id}
            title={sub.plan}
            sub={`${sub.seats} ${sub.seats === 1 ? "seat" : "seats"} · ${cycleScheduleLabel(sub.billing_cycle)}`}
          >
            {upcoming.length === 0 ? (
              <p className="text-sm text-ink-3">
                Nothing further is scheduled on this plan.
                {sub.renewal_date && ` It runs to ${formatDate(sub.renewal_date)}.`}
              </p>
            ) : (
              <ul className="divide-y divide-hairline">
                {upcoming.map((p, i) => (
                  <li key={`${sub.id}-${p.billOn}-${p.index}`} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-ink">
                        {formatDate(p.billOn)}
                        {i === 0 && <Badge kind="warning" size="sm" className="ml-2">next</Badge>}
                      </p>
                      <p className="text-[11px] text-ink-3">
                        covers {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium tabular-nums text-ink">{rupee(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}

            {current.length > 0 && (
              <p className="mt-2 text-[11px] text-ink-3">
                This term totals {rupee(scheduleTotal(current))} across{" "}
                {current.length} {current.length === 1 ? "invoice" : "invoices"}.
              </p>
            )}
          </Card>
        );
      })}

      {invoices && invoices.length > 0 && (
        <Card title="Recent invoices" sub="Already issued">
          <ul className="divide-y divide-hairline">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[13px] text-ink">{inv.id}</p>
                  <p className="text-[11px] text-ink-3">{formatDate(inv.invoice_date)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge kind={inv.status === "paid" ? "success" : inv.status === "overdue" ? "danger" : "warning"} size="sm">
                    {inv.status}
                  </Badge>
                  <span className="text-sm tabular-nums text-ink">{rupee(inv.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
          <Link href="/portal/invoices" className="mt-3 inline-block text-xs font-semibold text-ink underline">
            All invoices →
          </Link>
        </Card>
      )}

      <p className="px-1 text-[11px] leading-snug text-ink-3">
        Scheduled amounts are what is planned, not invoices. Each tax invoice is issued on
        its own date. If something here looks wrong, tell {session.tenantName} before it is
        raised — it is much easier to fix now than with a credit note afterwards.
      </p>
    </div>
  );
}
