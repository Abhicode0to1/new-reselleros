/**
 * /portal/orders — list of quotes the customer has on file.
 *
 * Includes accepted / sent / paid / invoiced quotes — anything they've
 * been billed for. Customer can see status + amount + when sent.
 */
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAYMENT_STATUS_COLOR: Record<string, "emerald" | "amber" | "rose" | "slate" | "indigo"> = {
  received: "emerald",
  partial:  "amber",
  awaiting: "rose",
  invoiced: "indigo",
  none:     "slate",
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
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Your Orders</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every quote and order on your account. Tax invoices are on the
          <span className="font-semibold text-ink"> Invoices</span> tab.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-ink-3">
          No orders yet. New orders take a few minutes to appear after {reseller}
          enters them in the system. Message {reseller} if you expect one to be here.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left  px-4 py-3">Order ID</th>
                <th className="text-left  px-4 py-3">Plan</th>
                <th className="text-right px-4 py-3">Seats</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="text-left  px-4 py-3">Created</th>
                <th className="text-left  px-4 py-3">Status</th>
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
                    <Badge color={PAYMENT_STATUS_COLOR[q.payment_status ?? "none"] ?? "slate"}>
                      {(q.payment_status ?? "none").replace("_", " ")}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
