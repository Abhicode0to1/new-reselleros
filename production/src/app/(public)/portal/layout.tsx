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
import { initials } from "@/lib/utils";
import { PortalAccountMenu } from "./_components/portal-account-menu";
import { PortalNavInline, PortalNavStrip } from "./_components/portal-nav";


export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session   = await getPortalSession();
  const brandName = session?.tenantName ?? "Customer Portal";
  const mark      = session ? initials(session.tenantName) : "•";
  const gstin     = session?.tenantGstin ?? null;

  return (
    <div className="min-h-screen bg-paper-2/40 flex flex-col">
      <header className="border-b border-hairline bg-paper">
        <div className="max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
          {/* min-h-[44px] for the ≥44px floor (CLAUDE.md:605, §20). It measured 236x36 on
              9 Sep — the 36px comes from the w-9 h-9 logo. Free of layout cost here: the
              account-menu trigger next to it already sets the row to 44px, so this grows
              the hit area without growing the header. */}
          <Link
            href={session ? "/portal/dashboard" : "/portal"}
            className="flex items-center gap-3 min-w-0 min-h-[44px]"
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
          <div className="flex items-center gap-5">
            {/* Section nav lives in _components/portal-nav.tsx — it needs usePathname to
                mark the current section, and this layout is a Server Component. The
                measurements behind its 1080px threshold and gap-4 are documented there. */}
            {session && <PortalNavInline />}
            {/* Account menu — always top-right when signed in (mobile + desktop) */}
            {session && (
              <PortalAccountMenu customerName={session.customerName} email={session.userEmail} />
            )}
          </div>
        </div>
        {session && <PortalNavStrip />}
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
