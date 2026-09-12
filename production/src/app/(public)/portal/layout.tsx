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
import { PortalThemeToggle } from "./_components/portal-theme-toggle";


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
      {session && (
        <PortalSidebar
          brandName={brandName}
          gstin={gstin}
          customerName={session.customerName}
          email={session.userEmail}
        />
      )}

      <div className={session ? "flex-1 flex flex-col min-w-0" : "contents"}>
      {/* ─── THE STAFF TOPBAR'S OWN FOUR PROPERTIES ─────────────────────
          Measured against `topbar.tsx:57` on 11 Sep 2026, from Pardeep's two
          screenshots. The heights matched; these did not:
            · sticky top-0 z-30 — the staff bar stays put while the page scrolls
              and the portal's scrolled away, so on a long invoice list the
              customer lost the breadcrumb and the account menu entirely
            · bg-paper/95 + backdrop-blur-sm — content passing UNDER a sticky bar
              has to show through it; an opaque bar is what an unsticky one wants
            · px-3 md:px-4 (16px) against px-6 (24px) — 8px of inset that made
              the two bars' left edges disagree with each other and with the rail
            · gap-2 against gap-4
          Signed out there is no rail and no app shell, so the bar keeps its
          centred measure and does not stick. */}
      <header className={session ? "sticky top-0 z-30 h-14 border-b border-hairline bg-paper/95 backdrop-blur-sm flex-shrink-0" : "border-b border-hairline bg-paper"}>
        {/* Signed in, the rail carries the brand and the header is a thin strip
            like the staff TopBar; signed out it is the whole chrome, so it keeps
            the centred measure. */}
        {/* `h-14` belongs on the <header>, not here: with it on the inner div the
           1px border is added OUTSIDE the 56px and the bar measures 57. The
           staff TopBar puts it on the element that carries the border
           (`topbar.tsx:57`), so the two now measure the same 56px. */}
        <div className={session
          ? "px-3 md:px-4 h-full flex items-center gap-2"
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

          {/* ─── THE RIGHT-HAND CLUSTER ──────────────────────────────
              `gap-5` was 20px where the staff bar uses the header's own `gap-2`.

              Section nav lives in _components/portal-nav.tsx — it needs
              usePathname to mark the current section, and this layout is a
              Server Component. The desktop row is gone: the rail is the
              navigation now. The phone strip below stays — it scrolls the active
              item into view and is a one-tap nav, which a sheet would not be. */}
          <div className="flex items-center gap-2">
            {session && <PortalThemeToggle />}
            {/* ─── md:hidden ──────────────────────────────────────
                On desktop the account chip is at the foot of the rail, where the
                staff app keeps it — which is what leaves this bar carrying the
                same kind of thing the staff bar carries. On a phone the rail is
                `hidden md:flex`, so the compact chip is the only way out. */}
            {session && (
              <div className="md:hidden">
                <PortalAccountMenu customerName={session.customerName} email={session.userEmail} />
              </div>
            )}
          </div>
        </div>
      </header>
      {/* ─── THE PHONE STRIP IS A BAND OF ITS OWN, NOT A HEADER CHILD ───────
          Measured at 390px on 11 Sep 2026: the strip stuck 44px out of the
          BOTTOM of a header fixed at `h-14`, so on every phone page it sat on
          top of the first 44px of the content — and once the bar became sticky
          and translucent it would have sat on top of whatever scrolled past.

          It cannot simply be given room inside the header: `h-14` has to stay on
          the element carrying the border, or the 1px is added outside the 56px
          and the bar measures 57 against the staff bar's 56 (the reason it moved
          there in 68ca1a1b). So the strip becomes the next band down, sticking
          at `top-14` — directly under the bar, which is where it was drawn
          anyway, and now it stays there while the page scrolls. */}
      {session && <PortalNavStrip />}
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
