/**
 * Customer Portal layout — shared chrome for /portal/* pages.
 *
 * Branding is now PER-TENANT (v1): the reseller's name + an auto initials
 * logo + their GSTIN in the footer, derived from the logged-in customer's
 * tenant via getPortalSession(). Before login (no session — e.g. /portal/login)
 * we show a neutral "Customer Portal" brand, because the visitor's reseller
 * isn't known until they authenticate. Accent stays the house amber (no
 * per-tenant colours in v1).
 */
import Link from "next/link";
import { getPortalSession } from "@/lib/portal/session";
import { initials } from "@/lib/utils";
import { PortalAccountMenu } from "./_components/portal-account-menu";

const NAV: Array<{ href: string; label: string }> = [
  { href: "/portal/dashboard",    label: "Dashboard" },
  { href: "/portal/subscription", label: "Subscription" },
  /* Assets before commerce. Domains and Hosting are the things the customer
     OWNS and the things that can lapse; Shop and Orders are what they did.
     Someone opening the portal because a site went down or a renewal notice
     arrived is looking for these two, and burying them under Orders would put
     the urgent thing behind the historical one. Added 8 Sep 2026 with the
     `domains` / `hosting_accounts` tables — before those, neither page could
     show anything, which is why the portal had no such section. */
  { href: "/portal/domains",      label: "Domains" },
  { href: "/portal/hosting",      label: "Hosting" },
  { href: "/portal/shop",         label: "Shop" },
  { href: "/portal/orders",       label: "Orders" },
  /* Before Invoices on purpose: Billing looks FORWARD at what is coming, Invoices
     back at what was issued, and a customer wondering "what will I be charged?"
     reaches for the first of those. Adding the page without adding it here is how a
     feature ships and nobody ever finds it — caught only because a screenshot of the
     real nav had no Billing in it. */
  { href: "/portal/billing",      label: "Billing" },
  { href: "/portal/invoices",     label: "Invoices" },
  { href: "/portal/support",      label: "Support" },
  { href: "/portal/profile",      label: "Profile" },
];

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session   = await getPortalSession();
  const brandName = session?.tenantName ?? "Customer Portal";
  const mark      = session ? initials(session.tenantName) : "•";
  const gstin     = session?.tenantGstin ?? null;

  return (
    <div className="min-h-screen bg-paper-2/40 flex flex-col">
      <header className="border-b border-hairline bg-paper">
        <div className="max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link href={session ? "/portal/dashboard" : "/portal"} className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 bg-ink text-paper rounded-md grid place-items-center font-serif text-base flex-shrink-0">
              {mark}
            </div>
            <div className="min-w-0">
              <div className="font-serif text-base leading-none truncate">{brandName}</div>
              <div className="text-3xs text-ink-3 mt-1">Customer Portal</div>
            </div>
          </Link>
          <div className="flex items-center gap-5">
            {/* Desktop nav — inline */}
            {session && (
              <nav aria-label="Portal sections" className="hidden md:flex items-center gap-5 text-sm text-ink-3">
                {NAV.map((n) => (
                  <Link key={n.href} href={n.href as never} className="hover:text-ink whitespace-nowrap">
                    {n.label}
                  </Link>
                ))}
              </nav>
            )}
            {/* Account menu — always top-right when signed in (mobile + desktop) */}
            {session && (
              <PortalAccountMenu customerName={session.customerName} email={session.userEmail} />
            )}
          </div>
        </div>
        {/* Mobile nav — horizontally scrollable strip so every section stays reachable */}
        {session && (
          <nav className="md:hidden border-t border-hairline overflow-x-auto" aria-label="Portal sections">
            <div className="flex items-center gap-5 px-6 py-2.5 text-sm text-ink-3 whitespace-nowrap min-w-max">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href as never} className="hover:text-ink">
                  {n.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-hairline bg-paper py-6 text-center text-xs text-ink-3 px-6">
        {session ? (
          <>
            {brandName}
            {gstin ? <> · GSTIN <span className="font-mono">{gstin}</span></> : null}
            {" "}· Powered by ResellerOS
          </>
        ) : (
          <>Customer Portal · Powered by ResellerOS</>
        )}
      </footer>
    </div>
  );
}
