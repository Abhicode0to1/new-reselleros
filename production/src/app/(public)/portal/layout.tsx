/**
 * Customer Portal layout — shared chrome for /portal/* pages.
 *
 * Branding is now PER-TENANT (v1): the reseller's name + an auto initials
 * logo + their GSTIN in the footer, derived from the logged-in customer's
 * tenant via getPortalSession(). Before login (no session — e.g. /portal/login)
 * we show a neutral "Customer Portal" brand, because the visitor's reseller
 * isn't known until they authenticate. Accent stays the house amber (no
 * per-tenant colours in v1).
 *
 * The "Customer Portal" sub-label under the brand is therefore rendered ONLY
 * with a session: unauthenticated, the brand line already says those words and
 * printing them twice is what the sign-in page did until 11 Sep 2026.
 */
import Link from "next/link";
import { getPortalSession } from "@/lib/portal/session";
import { cn, initials } from "@/lib/utils";
import { PortalAccountMenu } from "./_components/portal-account-menu";
import { PortalNavStrip } from "./_components/portal-nav";
import { PortalSidebar } from "./_components/portal-sidebar";
import { PortalBreadcrumb } from "./_components/portal-breadcrumb";


export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session   = await getPortalSession();
  const brandName = session?.tenantName ?? "Customer Portal";
  const mark      = session ? initials(session.tenantName) : "•";
  const gstin     = session?.tenantGstin ?? null;

  return (
    /* ─── THE STAFF APP'S SHELL: RAIL + CONTENT COLUMN ────────────────────────
       Changed 11 Sep 2026 — Pardeep: "i want my customer portal UI to
       consistent with old panel."

       The portal had already been moved onto the app's primitives, type,
       tokens, header shape and titled-card sections, and it STILL read as a
       different product. This is why: `(app)/layout.tsx` is
       `flex min-h-screen` with a 240px rail and a content column, and this was
       a centred 1080px column under a full-width bar. Shape decides what a
       screen looks like long before styling does.

       Signed OUT — the sign-in page — there is no rail, because there is
       nothing to navigate and a customer who cannot get in should not be shown
       ten links they cannot open. */
    <div className={session ? "flex min-h-screen bg-paper-2/50" : "min-h-screen bg-paper-2/40 flex flex-col"}>
      {session && <PortalSidebar brandName={brandName} gstin={gstin} />}

      <div className={session ? "flex-1 flex flex-col min-w-0" : "contents"}>
      <header className="border-b border-hairline bg-paper">
        {/* Signed in, the rail carries the brand and the header is a thin strip
            like the staff TopBar; signed out it is the whole chrome, so it keeps
            the centred measure. */}
        <div className={session
          ? "px-6 h-14 flex items-center gap-4"
          : "max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between gap-4"}>
          {/* min-h-[44px] for the ≥44px floor (CLAUDE.md:605, §20). It measured 236x36 on
              9 Sep — the 36px comes from the w-9 h-9 logo. Free of layout cost here: the
              account-menu trigger next to it already sets the row to 44px, so this grows
              the hit area without growing the header. */}
          {/* `md:hidden` when signed in: the rail shows this on desktop, and two
              copies of the same brand on one screen is what the staff app
              deliberately avoids. On a phone there is no rail, so it stays. */}
          <Link
            href={session ? "/portal/dashboard" : "/portal"}
            className={cn(
              "flex items-center gap-3 min-w-0 min-h-[44px]",
              session && "md:hidden",
            )}
          >
            <div className="w-9 h-9 bg-ink text-paper rounded-md grid place-items-center font-serif text-base flex-shrink-0">
              {mark}
            </div>
            <div className="min-w-0">
              <div className="font-serif text-base leading-none truncate">{brandName}</div>
              {/* ─── ONLY WHEN THERE IS A NAME ABOVE IT ──────────────────────
                  The line below labels what the reseller's name IS. With no
                  session there is no reseller name, `brandName` falls back to
                  "Customer Portal" — and this printed the identical words
                  underneath it. Reported 11 Sep 2026 from the sign-in page,
                  which is the FIRST thing a customer sees. */}
              {session && <div className="text-3xs text-ink-3 mt-1">Customer Portal</div>}
            </div>
          </Link>
          {/* ─── BREADCRUMB LEFT, ACCOUNT RIGHT — the staff TopBar's layout ────
              Fixed 11 Sep 2026. With the rail carrying the brand, the header had
              nothing left in it and the account chip sat at the LEFT edge of an
              otherwise empty bar, which reads as a broken row rather than a
              quiet one. `topbar.tsx:92` puts a breadcrumb on the left, a
              `flex-1` spacer after it, and everything else on the right.

              Hidden on a phone for the same reason it is there: the row belongs
              to the brand and the account when there is no space. */}
          {session && <PortalBreadcrumb />}

          <div className="flex-1" />

          <div className="flex items-center gap-5">
            {/* Section nav lives in _components/portal-nav.tsx — it needs usePathname to
                mark the current section, and this layout is a Server Component. The
                measurements behind its 1080px threshold and gap-4 are documented there. */}
            {/* The desktop row is gone — the rail is the navigation now. The
                phone strip below stays: it scrolls the active item into view and
                is a one-tap nav, which a hamburger sheet would not be. */}
            {/* Account menu — always top-right when signed in (mobile + desktop) */}
            {session && (
              <PortalAccountMenu customerName={session.customerName} email={session.userEmail} />
            )}
          </div>
        </div>
        {session && <PortalNavStrip />}
      </header>
      <main className="flex-1 min-w-0">{children}</main>
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
    </div>
  );
}
