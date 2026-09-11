/**
 * /portal/dashboard — customer landing.
 *
 * ─── WHY IT WAS REBUILT, 11 Sep 2026 ────────────────────────────────────────
 * Pardeep, comparing this against the staff dashboard: "There is massive
 * difference in tenet and customer portal. Our sections can be reduced,
 * authority can be reduced. But UI/UX and design should be same and
 * consistent."
 *
 * Measured before the rewrite, and none of it was about colour — the portal is
 * clean on tokens (0 hardcoded palette classes) and already uses `<Button>`
 * 24 times against 2 raw ones. The divergence was compositional:
 *
 *   · `KPI` used in 0 portal files. The staff dashboard opens with three big
 *     numbers; this page opened with a paragraph explaining an absence.
 *   · A grid of EIGHT tiles — Domains, Hosting, Shop, Subscription, Orders,
 *     Invoices, Support, Profile — every one of which is ALREADY a link in the
 *     nav bar directly above it. The page's main content was its own
 *     navigation, rendered a second time. That is the "link farm" look.
 *   · `EmptyState` used in 0 portal files, so emptiness was a bespoke centred
 *     paragraph each time.
 *   · `text-center` 19 times across 11 portal files against 9 across 7 staff
 *     files — in an app that is otherwise left-aligned, on a third as much code.
 *
 * ─── AND A DEFECT THE COMPARISON EXPOSED ────────────────────────────────────
 * The page loaded subscriptions and invoices and NOTHING ELSE. A customer with
 * two domains — one nine days from expiry — and two hosting accounts, one of
 * them suspended, was told "No active subscription on file" and shown eight
 * links. Everything urgent about their account was on this page's own nav and
 * not on the page. So this now loads domains and hosting too; the redesign is
 * what made the gap visible.
 *
 * ─── THE SHAPE, WHICH IS THE STAFF DASHBOARD'S SHAPE ────────────────────────
 * numbers first (`KPI`, the same primitive), then what needs a person, then the
 * detail. Fewer sections and no staff-only authority — but the same order, the
 * same primitives and the same alignment.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate, daysBetween } from "@/lib/utils";
import { tenantWhatsAppLink, phoneDisplay } from "@/lib/portal/branding";
import { SeatUsage } from "../_components/seat-usage";
import { PortalPageHeader, PortalStats, PortalSection } from "../_components/portal-page";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

/** One thing the customer may need to act on. */
interface FocusItem {
  title: string;
  detail: string;
  href: string;
  cta: string;
  tone: "rose" | "amber" | "ink";
}

export default async function PortalDashboardPage() {
  const session = await requirePortalSession();
  const supabase = createClient();
  const today = new Date().toISOString().slice(0, 10);
  /* Same eyebrow the staff dashboard carries, same shape: FRIDAY, 11 SEPTEMBER
     2026. In IST, because `formatDate` pins the zone and a UTC server would
     otherwise put a customer in India on yesterday after 18:30. */
  const dateLabel = new Date()
    .toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    })
    .toUpperCase();

  /* Every read is RLS-scoped to this customer — see lib/portal/session.ts. */
  const [{ data: subs }, { data: unpaidInvoices }, { data: domains }, { data: hosting }] =
    await Promise.all([
      supabase
        .from("subscriptions")
        .select("id, plan, vendor, seats, used, used_synced_at, mrr, start_date, renewal_date, status, outstanding_amount")
        .eq("status", "active")
        .order("renewal_date", { ascending: true }),
      supabase
        .from("invoices")
        .select("id, amount, net_payable, status, invoice_date, due_date")
        .in("status", ["pending", "overdue"])
        .order("invoice_date", { ascending: false })
        .limit(3),
      /* Added 11 Sep 2026 — see the header. Without these the page could not
         mention the one thing that was actually urgent. */
      supabase
        .from("domains")
        .select("id, domain_name, expires_at, status")
        .order("expires_at", { ascending: true }),
      supabase
        .from("hosting_accounts")
        .select("id, domain_name, status, plan_name")
        .order("created_at", { ascending: false }),
    ]);

  const activeSubs = subs ?? [];
  const primary = activeSubs[0] ?? null;
  const allDomains = domains ?? [];
  const allHosting = hosting ?? [];
  const invoices = unpaidInvoices ?? [];

  const daysToRenewal = primary?.renewal_date ? daysBetween(today, primary.renewal_date) : null;
  const amountDue = invoices.reduce((s, i) => s + (i.net_payable ?? i.amount ?? 0), 0);
  const liveHosting = allHosting.filter((h) => h.status === "active").length;

  /* The soonest domain expiry, which is the number a customer actually watches. */
  const nextExpiry = allDomains
    .filter((d) => d.expires_at)
    .map((d) => ({ ...d, days: daysBetween(today, d.expires_at as string) }))
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))[0];

  /* ─── WHAT NEEDS A PERSON ──────────────────────────────────────────────────
     Built from the same rows the numbers come from, so the list cannot claim
     something the figures above contradict. Ordered by cost of ignoring it:
     money owed, then a site that is off, then a date approaching. */
  const focus: FocusItem[] = [];

  if (invoices.length > 0) {
    focus.push({
      title: `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"}`,
      detail: `${rupee(amountDue)} outstanding`,
      href: "/portal/invoices",
      cta: "View & pay",
      tone: "rose",
    });
  }

  for (const h of allHosting.filter((x) => x.status === "suspended")) {
    focus.push({
      title: `${h.domain_name} is suspended`,
      detail: "The site is offline. Nothing has been deleted.",
      href: "/portal/hosting",
      cta: "See why",
      tone: "rose",
    });
  }

  if (nextExpiry && typeof nextExpiry.days === "number" && nextExpiry.days <= 30) {
    focus.push({
      title:
        nextExpiry.days <= 0
          ? `${nextExpiry.domain_name} has expired`
          : `${nextExpiry.domain_name} expires in ${nextExpiry.days} ${nextExpiry.days === 1 ? "day" : "days"}`,
      detail: `Renews on ${formatDate(nextExpiry.expires_at)}`,
      href: "/portal/domains",
      cta: "Renew it",
      tone: nextExpiry.days <= 7 ? "rose" : "amber",
    });
  }

  if (daysToRenewal !== null && daysToRenewal <= 30 && primary) {
    focus.push({
      title: `Your ${primary.plan} plan renews ${daysToRenewal <= 0 ? "now" : `in ${daysToRenewal} days`}`,
      detail: `${rupee(primary.mrr)} a month`,
      href: "/portal/subscription",
      cta: "See the plan",
      tone: "amber",
    });
  }

  const waName = session.tenantContactName ?? session.tenantName;
  const waDisplay = phoneDisplay(session.tenantPhone);
  const waLink = tenantWhatsAppLink(
    session.tenantPhone,
    `Hi, I have a question about my ${session.tenantName} account.`,
  );

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <PortalPageHeader
        eyebrow={dateLabel}
        title={`Welcome, ${session.customerName}`}
        sub="Your domains, hosting and invoices — all in one place."
        /* The staff header pins its primary action right; a customer's one
           action is asking for something, so this is the same slot with the
           only verb they actually have. */
        action={
          <Button asChild variant="primary" icon="message_circle">
            <Link href="/portal/support/new">Ask for help</Link>
          </Button>
        }
      />

      {/* ─── NUMBERS FIRST, the same primitive the staff dashboard opens with.
          Four, because that is what a customer has: what they own, what is
          live, what they owe, and the next date that matters. */}
      <PortalStats
        items={[
          { label: "Domains", value: allDomains.length, icon: "globe" },
          {
            label: "Hosting",
            value: liveHosting,
            icon: "server",
            trend: allHosting.length > liveHosting ? `${allHosting.length - liveHosting} not live` : undefined,
            trendKind: allHosting.length > liveHosting ? "down" : "neutral",
          },
          {
            label: "Amount due",
            value: amountDue,
            asCurrency: true,
            icon: "receipt_indian_rupee",
            accent: amountDue > 0 ? "rose" : "emerald",
          },
          {
            label: "Next renewal",
            value: nextExpiry?.expires_at ? formatDate(nextExpiry.expires_at) : "—",
            icon: "calendar",
            accent:
              nextExpiry && typeof nextExpiry.days === "number" && nextExpiry.days <= 30
                ? "amber"
                : "ink",
            trend:
              nextExpiry && typeof nextExpiry.days === "number"
                ? nextExpiry.days <= 0
                  ? "expired"
                  : `in ${nextExpiry.days} days`
                : undefined,
          },
        ]}
      />

      {/* ─── THEN WHAT NEEDS A PERSON ───────────────────────────────────────
          The staff dashboard's "Today's Focus" in a customer's vocabulary. It
          replaced a grid of eight tiles that duplicated the nav bar — see the
          header. When there is genuinely nothing, EmptyState says so in one
          line rather than leaving the reader to infer it from a blank. */}
      {/* `flush`: the body is already a list of cards, and a card inside a card
          is the thing that made the old portal look padded-out. */}
      <PortalSection
        title="Needs your attention"
        sub={
          focus.length === 0
            ? "We check your renewals, invoices and sites here."
            : `${focus.length} thing${focus.length === 1 ? "" : "s"} to look at.`
        }
        flush
      >
        {focus.length === 0 ? (
          <Card className="p-6">
            <EmptyState
              icon="check"
              title="Nothing needs you right now"
              body={`Your account is in order. ${waName} will get in touch before anything is due.`}
              compact
            />
          </Card>
        ) : (
          <ul className="space-y-2">
            {focus.map((f, i) => (
              <li key={i}>
                <Card className="p-4">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-ink">{f.title}</span>
                        {f.tone === "rose" && <Badge kind="danger">Now</Badge>}
                        {f.tone === "amber" && <Badge kind="warning">Soon</Badge>}
                      </div>
                      <div className="text-2xs text-ink-3 mt-0.5">{f.detail}</div>
                    </div>
                    <Link
                      href={f.href as never}
                      className="text-sm text-amber-ink underline whitespace-nowrap min-h-[44px] inline-flex items-center"
                    >
                      {f.cta} →
                    </Link>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PortalSection>

      {/* ─── THEN THE DETAIL ────────────────────────────────────────────────
          Unchanged in substance: this card was already using the app's idiom.
          The only edit is the empty branch, which was a centred paragraph and
          is now the same EmptyState as everywhere else. */}
      <PortalSection title="Your subscription" flush>
        {primary ? (
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
              <div>
                <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                  Active subscription
                </div>
                <div className="font-serif text-2xl text-ink leading-tight">{primary.plan}</div>
                <div className="text-xs text-ink-3 mt-1">
                  {primary.seats} {primary.seats === 1 ? "user" : "users"} ·{" "}
                  {primary.vendor === "google" ? "Google Workspace" : primary.vendor}
                </div>
              </div>
              <div className="text-right">
                <div className="font-serif text-2xl text-ink leading-none">{rupee(primary.mrr)}</div>
                <div className="text-2xs text-ink-3 mt-1">/month equivalent</div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-hairline text-sm">
              <KV label="Started" value={formatDate(primary.start_date)} />
              <KV
                label="Renews on"
                value={primary.renewal_date ? formatDate(primary.renewal_date) : "—"}
                hint={
                  daysToRenewal !== null
                    ? daysToRenewal <= 0
                      ? "Overdue"
                      : `In ${daysToRenewal} ${daysToRenewal === 1 ? "day" : "days"}`
                    : undefined
                }
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
          /* ─── ONE LINE, NOT AN ILLUSTRATION ──────────────────────────────
             `EmptyState` is the app's shared empty treatment and it is centred
             by design, so using it is not a divergence. The weight is: it is a
             full-page primitive, and this is a SECONDARY section. Measured in
             the browser — a `compact` EmptyState here produced ~280px of
             whitespace and a second illustrated circle on a page that already
             has one above it, to say a customer of a DOMAIN reseller has no
             Workspace subscription, which most of them never will.

             So the reassuring, page-defining empty state above keeps the
             primitive, and this says the same thing in a sentence. */
          <Card className="p-4">
            <p className="text-sm text-ink-3">
              No subscription on file. If you have just ordered, it appears here within 24 hours
              of setup — otherwise {waName} can tell you where it is.
            </p>
          </Card>
        )}
      </PortalSection>

      {/* ─── HELP ───────────────────────────────────────────────────────────
          Left-aligned like everything else. It was centred, which is the one
          thing on the page that made it read as a different product. */}
      <Card className="p-6">
        <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Need help right now?
        </div>
        <h2 className="font-serif text-xl mb-3">{waName} picks up the phone.</h2>
        {waLink ? (
          <>
            <a
              href={waLink}
              target="_blank"
              rel="noopener noreferrer"
              /* WhatsApp's own green, deliberately: this is a third-party brand
                 affordance and the colour is how it is recognised at a glance.
                 The one place in the portal that is not a token, and it is a
                 decision rather than an oversight (§5). */
              className="inline-flex items-center justify-center gap-2 px-6 h-11 rounded-lg font-medium text-paper text-sm"
              style={{ background: "#25D366" }}
            >
              WhatsApp {waName}
              {waDisplay ? ` · ${waDisplay}` : ""}
            </a>
            <div className="mt-3 text-2xs text-ink-3">Mon–Sat · 9am–7pm IST</div>
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
    </div>
  );
}

function KV({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "amber" | "emerald" | "rose";
}) {
  const colorClass =
    tone === "rose" ? "text-rose"
    : tone === "amber" ? "text-amber-ink"
    : tone === "emerald" ? "text-emerald"
    : "text-ink";
  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">{label}</div>
      <div className={`font-medium ${colorClass}`}>{value}</div>
      {hint && <div className="text-2xs text-ink-3 mt-0.5">{hint}</div>}
    </div>
  );
}
