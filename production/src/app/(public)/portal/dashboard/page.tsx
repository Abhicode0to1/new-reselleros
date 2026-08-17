/**
 * /portal/dashboard — customer landing.
 * Shows their active subscription, next renewal countdown, and
 * a prominent WhatsApp-Pardeep CTA.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { rupee, formatDate, daysBetween } from "@/lib/utils";
import { tenantWhatsAppLink, phoneDisplay } from "@/lib/portal/branding";
import { SeatUsage } from "../_components/seat-usage";

export const dynamic = "force-dynamic";

export default async function PortalDashboardPage() {
  const session  = await requirePortalSession();
  const supabase = createClient();

  // Active subscription (RLS gives us only ours)
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("id, plan, vendor, seats, used, used_synced_at, mrr, start_date, renewal_date, status, outstanding_amount")
    .eq("status", "active")
    .order("renewal_date", { ascending: true });

  const activeSubs = subs ?? [];
  const primary    = activeSubs[0] ?? null;

  // Most recent unpaid invoice (for nudge)
  const { data: unpaidInvoices } = await supabase
    .from("invoices")
    .select("id, amount, net_payable, status, invoice_date, due_date")
    .in("status", ["pending", "overdue"])
    .order("invoice_date", { ascending: false })
    .limit(3);

  const today = new Date().toISOString().slice(0, 10);
  const daysToRenewal = primary?.renewal_date
    ? daysBetween(today, primary.renewal_date)
    : null;

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      {/* Greeting */}
      <div className="mb-8">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">
          Welcome, {session.customerName}
        </h1>
        <p className="text-sm text-ink-3 mt-1">
          Your subscription, orders and invoices — all in one place.
        </p>
      </div>

      {/* Primary subscription card */}
      {primary ? (
        <Card className="p-6 mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1">
                Active subscription
              </div>
              <div className="font-serif text-2xl text-ink leading-tight">{primary.plan}</div>
              <div className="text-xs text-ink-3 mt-1">
                {primary.seats} {primary.seats === 1 ? "user" : "users"} ·
                {" "}{primary.vendor === "google" ? "Google Workspace" : primary.vendor}
              </div>
            </div>
            <div className="text-right">
              <div className="font-serif text-2xl text-ink leading-none">{rupee(primary.mrr)}</div>
              <div className="text-[11px] text-ink-3 mt-1">/month equivalent</div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-hairline text-sm">
            <KV label="Started" value={formatDate(primary.start_date)} />
            <KV
              label="Renews on"
              value={primary.renewal_date ? formatDate(primary.renewal_date) : "—"}
              hint={daysToRenewal !== null
                ? daysToRenewal <= 0 ? "Overdue" : `In ${daysToRenewal} ${daysToRenewal === 1 ? "day" : "days"}`
                : undefined}
              tone={daysToRenewal !== null && daysToRenewal <= 30 ? "amber" : undefined}
            />
            <KV
              label="Outstanding"
              value={primary.outstanding_amount > 0 ? rupee(primary.outstanding_amount) : "Nil"}
              tone={primary.outstanding_amount > 0 ? "rose" : "emerald"}
            />
          </div>

          {typeof primary.seats === "number" && primary.seats > 0 && (
            <div className="mt-5 pt-4 border-t border-hairline">
              <SeatUsage used={primary.used} seats={primary.seats} usedSyncedAt={primary.used_synced_at} />
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-6 mb-6 text-center text-sm text-ink-3">
          No active subscription on file. If you&apos;ve recently ordered, it&apos;ll
          appear here within 24 hours of provisioning. Otherwise contact {session.tenantContactName ?? session.tenantName}.
        </Card>
      )}

      {/* Unpaid invoice nudge */}
      {unpaidInvoices && unpaidInvoices.length > 0 && (
        <Card className="p-5 mb-6 bg-amber-soft/30 border-amber/40">
          <div className="text-sm text-ink-2">
            <b>{unpaidInvoices.length} unpaid invoice{unpaidInvoices.length === 1 ? "" : "s"}</b> on
            your account totaling <b>{rupee(unpaidInvoices.reduce((s, i) => s + (i.net_payable ?? i.amount), 0))}</b>.
            {" "}<Link href="/portal/invoices" className="text-amber-ink underline">View &amp; pay →</Link>
          </div>
        </Card>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <QuickLink href="/portal/shop"         title="Shop"         sub="Buy more products" />
        <QuickLink href="/portal/subscription" title="Subscription" sub="Manage plan + auto-renew" />
        <QuickLink href="/portal/orders"       title="Orders"       sub="Quote + order history" />
        <QuickLink href="/portal/invoices"     title="Invoices"     sub="GST tax invoices" />
        <QuickLink href="/portal/support"      title="Support"      sub="Raise a ticket" />
        <QuickLink href="/portal/profile"      title="Profile"      sub="Company + GSTIN" />
      </div>

      {/* Support — reseller's own contact (per-tenant) */}
      {(() => {
        const waName    = session.tenantContactName ?? session.tenantName;
        const waDisplay = phoneDisplay(session.tenantPhone);
        const waLink    = tenantWhatsAppLink(
          session.tenantPhone,
          `Hi, I have a question about my ${session.tenantName} subscription.`,
        );
        return (
          <Card className="p-6 text-center">
            <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
              Need help right now?
            </div>
            <h2 className="font-serif text-xl mb-3">{waName} picks up the phone.</h2>
            {waLink ? (
              <>
                <a
                  href={waLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 px-6 h-11 rounded-lg font-medium text-paper text-sm"
                  style={{ background: "#25D366" }}
                >
                  WhatsApp {waName}{waDisplay ? ` · ${waDisplay}` : ""}
                </a>
                <div className="mt-3 text-[11px] text-ink-3">Mon–Sat · 9am–7pm IST</div>
              </>
            ) : (
              <Link
                href="/portal/support"
                className="inline-flex items-center justify-center gap-2 px-6 h-11 rounded-lg font-medium text-paper text-sm bg-amber"
              >
                Raise a support ticket
              </Link>
            )}
          </Card>
        );
      })()}
    </div>
  );
}

function KV({
  label, value, hint, tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "amber" | "emerald" | "rose";
}) {
  const colorClass = tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : tone === "emerald" ? "text-emerald"
                   : "text-ink";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">{label}</div>
      <div className={`font-medium ${colorClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink-3 mt-0.5">{hint}</div>}
    </div>
  );
}

function QuickLink({ href, title, sub }: { href: "/portal/shop" | "/portal/orders" | "/portal/invoices" | "/portal/profile" | "/portal/subscription" | "/portal/support"; title: string; sub: string }) {
  return (
    <Link href={href as never} className="block h-full">
      <Card className="p-4 h-full hover:bg-paper-2/40 transition-colors">
        <div className="font-serif text-base text-ink">{title}</div>
        <div className="text-[11px] text-ink-3 mt-0.5">{sub}</div>
      </Card>
    </Link>
  );
}
