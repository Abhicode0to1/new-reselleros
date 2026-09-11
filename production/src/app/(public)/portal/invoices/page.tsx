/**
 * /portal/invoices — list of GST tax invoices issued to the customer.
 *
 * "Download PDF" links straight to the existing PDF generator URL used
 * elsewhere in the app. For now just lists invoices — PDF generation
 * happens server-side via the existing /lib/pdf pipeline.
 */
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { tenantWhatsAppLink, phoneDisplay } from "@/lib/portal/branding";
import { PayInvoiceButton } from "./_components/pay-invoice-button";
import { PortalPageHeader, PortalStats } from "../_components/portal-page";
import { EmptyState } from "@/components/shared/empty-state";

export const dynamic = "force-dynamic";

/* Badge takes `kind`, not `color`. Every one of these pills was passing
   `color=` — which BadgeProps accepts only because it extends
   HTMLAttributes, so it landed on the <span> as a dead DOM attribute and
   the badge rendered muted grey whatever the status was: paid, overdue and
   draft all looked identical. Fixed 8 Sep 2026. */
const STATUS_KIND: Record<string, "success" | "warning" | "danger" | "muted"> = {
  paid:    "success",
  pending: "warning",
  overdue: "danger",
  void:    "muted",
  draft:   "muted",
};

export default async function PortalInvoicesPage() {
  const session  = await requirePortalSession();
  const reseller = session.tenantContactName ?? session.tenantName;
  const supabase = createClient();

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, amount, net_payable, status, invoice_date, due_date, paid_date, gst_irn")
    .order("invoice_date", { ascending: false });

  const rows = invoices ?? [];
  /* `net_payable` is what the customer actually owes after any TDS; `amount` is
     the pre-deduction figure. Falling back to `amount` would overstate the
     total on every invoice where tax was deducted at source. */
  const unpaid = rows.filter((r) => r.status === "pending" || r.status === "overdue");
  const unpaidCount = unpaid.length;
  const amountDue = unpaid.reduce((s, r) => s + (r.net_payable ?? r.amount ?? 0), 0);

  const totalOutstanding = rows
    .filter((i) => i.status === "pending" || i.status === "overdue")
    .reduce((s, i) => s + (i.net_payable ?? i.amount), 0);

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <PortalPageHeader
        title="Tax Invoices"
        sub="GST tax invoices issued to your account · HSN 998313 · 18% GST."
      />

      {/* What is owed comes first: it is the only number on this page that asks
          the reader to do something. */}
      <PortalStats
        items={[
          { label: "Invoices", value: rows.length, icon: "receipt_indian_rupee" },
          {
            label: "Unpaid",
            value: unpaidCount,
            icon: "alert_triangle",
            accent: unpaidCount > 0 ? "rose" : "emerald",
          },
          {
            label: "Amount due",
            value: amountDue,
            asCurrency: true,
            icon: "indian_rupee",
            accent: amountDue > 0 ? "rose" : "emerald",
          },
        ]}
      />

      {totalOutstanding > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <div className="text-sm text-ink-2">
            <b>{rupee(totalOutstanding)}</b> outstanding across your unpaid invoices.
            Pay via UPI / NEFT / Razorpay and {reseller} will mark them cleared.
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon="receipt_indian_rupee"
            title="No invoices yet"
            body={`They appear here once ${reseller} raises a tax invoice against your paid order.`}
            compact
          />
        </Card>
      ) : (
        <>
        {/* ── Phone: card list (§20 — ye page WhatsApp-link se phone par khulta
               hai; table wahan horizontal-scroll ban jati thi, audit B5). ── */}
        <ul className="md:hidden space-y-3">
          {rows.map((inv) => (
            <li key={inv.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm text-ink">{inv.id}</p>
                    <p className="mt-0.5 text-2xs text-ink-3">{formatDate(inv.invoice_date)}</p>
                  </div>
                  <Badge kind={STATUS_KIND[inv.status] ?? "muted"}>{inv.status}</Badge>
                </div>
                <div className="mt-3 flex items-end justify-between gap-3">
                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Net payable</p>
                    <p className="font-mono text-lg font-semibold text-ink">{rupee(inv.net_payable ?? inv.amount)}</p>
                    {inv.net_payable != null && inv.net_payable !== inv.amount && (
                      <p className="text-2xs text-ink-3">Invoice {rupee(inv.amount)}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {(inv.status === "pending" || inv.status === "overdue") && (
                      <PayInvoiceButton invoiceId={inv.id} email={session.userEmail} />
                    )}
                    <a
                      href={`/api/portal/invoice/${encodeURIComponent(inv.id)}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-amber-ink hover:underline whitespace-nowrap py-2"
                    >
                      PDF ↓
                    </a>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>

        <Card className="overflow-hidden hidden md:block">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left  px-4 py-3">Invoice #</th>
                <th className="text-left  px-4 py-3">Date</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="text-right px-4 py-3">Net payable</th>
                <th className="text-left  px-4 py-3">IRN</th>
                <th className="text-left  px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((inv) => (
                <tr key={inv.id} className="hover:bg-paper-2/40">
                  <td className="px-4 py-3 font-mono text-ink">{inv.id}</td>
                  <td className="px-4 py-3 text-ink-3">{formatDate(inv.invoice_date)}</td>
                  <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(inv.amount)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-ink">
                    {rupee(inv.net_payable ?? inv.amount)}
                  </td>
                  <td className="px-4 py-3 font-mono text-3xs text-ink-3 max-w-[140px] truncate">
                    {inv.gst_irn ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge kind={STATUS_KIND[inv.status] ?? "muted"}>{inv.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      {(inv.status === "pending" || inv.status === "overdue") && (
                        <PayInvoiceButton invoiceId={inv.id} email={session.userEmail} />
                      )}
                      <a
                        href={`/api/portal/invoice/${encodeURIComponent(inv.id)}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-amber-ink hover:underline whitespace-nowrap"
                      >
                        PDF ↓
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        </>
      )}

      {tenantWhatsAppLink(session.tenantPhone, `Hi ${reseller}, I have a question about an invoice.`) && (
        <div className="mt-6 text-2xs text-ink-3 text-center">
          Questions about an invoice? WhatsApp {reseller} on{" "}
          <a
            href={tenantWhatsAppLink(session.tenantPhone, `Hi ${reseller}, I have a question about an invoice.`)!}
            target="_blank" rel="noopener noreferrer"
            className="text-amber-ink hover:underline"
          >
            {phoneDisplay(session.tenantPhone)}
          </a>
        </div>
      )}
    </div>
  );
}
