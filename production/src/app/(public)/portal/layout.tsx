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
            {/* Desktop nav — inline, and only once there is genuinely room for it.
                This switches at 1080px — the header's OWN max-width — not at a
                t-shirt breakpoint, and that is a measurement rather than a preference.
                lg (1024px) was tried first and left a 34px band: 1024 is iPad LANDSCAPE,
                and there the brand still truncated to 154px of the 188 it needs, because
                below 1080 the header has less room than it is designed around. Tying the
                switch to 1080 means the inline nav appears exactly when the header
                reaches full width, and never before. With Domains and Hosting added (8 Sep) the inline nav needs
                725px, and the header row around it 794px. At the md breakpoint the
                viewport is 768px, so the row pushed the PAGE into horizontal scroll —
                measured 9 Sep 2026: 66px over at 768px wide, 34px at 800, 4px at 830,
                clear by 860. 768x1024 is iPad portrait, so this was a real device and
                every /portal/* page had it, not just the two new ones. Hiding just those
                two links in the browser took the overflow to 0, which is what identified
                them. Below 1080 the scrollable strip below handles it, which is the pattern
                that was already right; raising the threshold is what makes an 11th nav
                item fail safe instead of silently breaking the page again. */}
            {/* And gap-4, not gap-5, because the 4px matters. The header row is capped at
                max-w-[1080px] with px-6, so everything competes for 1032px — that cap is
                what makes this one viewport-INDEPENDENT: measured 9 Sep 2026 the brand
                truncated to "Excel Technologies Pv..." at 1440 and at every width above
                1080, because the nav group had grown to 794px and left the brand 238px
                where it needed 252. The brand carries min-w-0, so it is the flex item that
                silently gives, and what it gives up is the name of the business the
                customer is buying from. Nine gaps at 4px less each returns 36px, which
                covers the 14px shortfall with room over. If a future nav item eats that
                room, widen the budget or shorten labels — do not let the brand absorb it
                again. */}
            {session && (
              <nav aria-label="Portal sections" className="hidden min-[1080px]:flex items-center gap-4 text-sm text-ink-3">
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
        {/* Narrow nav — phone AND tablet, up to 1080px. A horizontally scrollable strip so
            every section stays reachable: it scrolls INSIDE itself (overflow-x-auto +
            min-w-max), which is why it never pushed the page the way the inline nav did. */}
        {session && (
          <nav className="min-[1080px]:hidden border-t border-hairline overflow-x-auto" aria-label="Portal sections">
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
