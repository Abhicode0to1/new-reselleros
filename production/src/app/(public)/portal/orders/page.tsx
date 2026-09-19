/**
 * /portal/orders — list of quotes the customer has on file.
 *
 * Includes accepted / sent / paid / invoiced quotes — anything they've
 * been billed for. Customer can see status + amount + when sent.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { PortalPageHeader, PortalStats } from "../_components/portal-page";
import { EmptyState } from "@/components/shared/empty-state";

export const dynamic = "force-dynamic";

/* Badge takes `kind`, not `color`. Every one of these pills was passing
   `color=` — which BadgeProps accepts only because it extends
   HTMLAttributes, so it landed on the <span> as a dead DOM attribute and
   the badge rendered muted grey whatever the status was: paid, overdue and
   draft all looked identical. Fixed 8 Sep 2026. */
/**
 * Where an order LED. Measured 16 Sep 2026: this screen showed a paid ₹235 order
 * and the whole <main> contained ZERO links — nothing to click, on the page a
 * customer opens to ask "what did I buy and where is it?".
 *
 * Only for an order that actually produced something. `received` is the only
 * status that means the money arrived (the others in the map below are none /
 * awaiting / partial / invoiced), and promising "View hosting" for an unpaid
 * order would be a link to an account that does not exist yet.
 *
 * The `hosting-` prefix is not a guess: `hostingPlanLabel` in
 * lib/portal/hosting-order.ts builds every hosting plan label that way, and the
 * public cart writes the same shape. Everything else on this screen is a
 * workspace plan — measured: "Plus", "Plus + Voice", "Workspace Std".
 */
function orderDestination(
  plan: string | null,
  paymentStatus: string | null,
): { href: string; label: string } | null {
  if (paymentStatus !== "received") return null;
  return (plan ?? "").startsWith("hosting-")
    ? { href: "/portal/hosting", label: "View hosting" }
    : { href: "/portal/subscription", label: "View subscription" };
}

const PAYMENT_STATUS_KIND: Record<string, "success" | "warning" | "danger" | "muted" | "info"> = {
  received: "success",
  partial:  "warning",
  awaiting: "danger",
  invoiced: "info",
  none:     "muted",
};

export default async function PortalOrdersPage() {
  const session  = await requirePortalSession();
  const reseller = session.tenantContactName ?? session.tenantName;
  const supabase = createClient();

  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, plan, seats, amount, status, payment_status, created_date, expires_date")
    .order("created_date", { ascending: false });

  const rows = quotes ?? [];

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <PortalPageHeader
        title="Your Orders"
        sub="Every quote and order on your account. Tax invoices are on the Invoices tab."
      />

      <PortalStats
        items={[
          { label: "Orders", value: rows.length, icon: "inbox" },
          /* The vocabulary is this page's own — `PAYMENT_STATUS_KIND` above —
             not one invented here. I first wrote `payment_status === "paid"`,
             which does not exist in the union; tsc caught it. The real values
             are none / awaiting / partial / invoiced / received, and only
             `received` means the money has actually arrived. */
          {
            label: "Awaiting payment",
            value: rows.filter((r) => r.payment_status === "awaiting" || r.payment_status === "partial").length,
            icon: "clock",
            accent: rows.some((r) => r.payment_status === "awaiting" || r.payment_status === "partial")
              ? "amber"
              : "ink",
          },
          {
            label: "Paid",
            value: rows.filter((r) => r.payment_status === "received").length,
            icon: "check",
            accent: "emerald",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon="inbox"
            title="No orders yet"
            body={`New orders take a few minutes to appear after ${reseller} enters them. Message ${reseller} if you expect one to be here.`}
            compact
          />
        </Card>
      ) : (
        <>
        {/* Phone: card list (§20, audit B5) — portal phone-first surface hai. */}
        <ul className="md:hidden space-y-3">
          {rows.map((q) => (
            <li key={q.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-ink">{q.id}</p>
                    <p className="mt-0.5 text-2xs text-ink-3 truncate" title={q.plan ?? undefined}>
                      {q.plan ?? "—"}{q.seats != null ? ` · ${q.seats} seats` : ""}
                    </p>
                  </div>
                  <Badge kind={PAYMENT_STATUS_KIND[q.payment_status ?? "none"] ?? "muted"}>
                    {(q.payment_status ?? "none").replace("_", " ")}
                  </Badge>
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <p className="font-mono text-lg font-semibold text-ink">{rupee(q.amount)}</p>
                  <p className="text-2xs text-ink-3">{formatDate(q.created_date)}</p>
                </div>
                {(() => {
                  const to = orderDestination(q.plan, q.payment_status);
                  return to ? (
                    <Link
                      href={to.href as never}
                      className="mt-3 inline-flex min-h-11 items-center text-xs font-medium text-amber-ink hover:underline"
                    >
                      {to.label} →
                    </Link>
                  ) : null;
                })()}
              </Card>
            </li>
          ))}
        </ul>

        <Card className="overflow-hidden hidden md:block">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left  px-4 py-3">Order ID</th>
                <th className="text-left  px-4 py-3">Plan</th>
                <th className="text-right px-4 py-3">Seats</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="text-left  px-4 py-3">Created</th>
                <th className="text-left  px-4 py-3">Status</th>
                <th className="text-right px-4 py-3"><span className="sr-only">What this order gave you</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((q) => (
                <tr key={q.id} className="hover:bg-paper-2/40">
                  <td className="px-4 py-3 font-mono text-ink">{q.id}</td>
                  <td className="px-4 py-3 text-ink-2">{q.plan ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-ink-2 font-mono">{q.seats ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-semibold text-ink font-mono">{rupee(q.amount)}</td>
                  <td className="px-4 py-3 text-ink-3">{formatDate(q.created_date)}</td>
                  <td className="px-4 py-3">
                    <Badge kind={PAYMENT_STATUS_KIND[q.payment_status ?? "none"] ?? "muted"}>
                      {(q.payment_status ?? "none").replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(() => {
                      const to = orderDestination(q.plan, q.payment_status);
                      return to ? (
                        <Link
                          href={to.href as never}
                          className="inline-flex min-h-11 items-center text-xs font-medium text-amber-ink hover:underline"
                        >
                          {to.label} →
                        </Link>
                      ) : null;
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </>
      )}
    </div>
  );
}
