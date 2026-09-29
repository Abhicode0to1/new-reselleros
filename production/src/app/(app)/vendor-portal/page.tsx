/**
 * /vendor-portal — NOT BUILT YET, and this page now says so.
 *
 * ─── WHAT WAS HERE UNTIL 28 SEP 2026 (S35) ──────────────────────────────────
 * A 2,947-line "Vendor Portal & Bids" screen, live in the sidebar under Purchase Orders.
 * Everything on it that looked like business data was invented: hardcoded distributor
 * bids (named real companies, with made-up per-seat rates, SLA scores and support
 * phone numbers), sample RFQs, vendor bills and scorecards — and any edit went to
 * localStorage, so it lived in one browser and nowhere else. A rep could read a
 * "Tier-1 CSP rate" off it and quote a customer against a number nobody had ever been
 * offered.
 *
 * A screen that shows fiction in the same typography as the books is worse than no
 * screen. It is out of the nav (lib/nav.ts) and this notice replaces it; the route stays
 * so old bookmarks and links land somewhere honest instead of a 404. Rebuilding it on
 * real data (vendor price lists, RFQs in the DB) is a product decision, not a refactor.
 *
 * Where the real work already lives:
 *   · vendors and their ledgers  → /accounting/vendors
 *   · raising a purchase order   → /purchase-orders
 *   · vendor bills (COGS)        → /accounting/bills
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";

export default function VendorPortalPage() {
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <div className="rounded-lg border border-hairline bg-paper p-6 sm:p-8">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-paper-2 text-ink-3">
          <Icon name="cart" size={22} />
        </div>
        <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">Coming later</p>
        <h1 className="mt-1 font-serif text-xl font-bold text-ink sm:text-2xl">Vendor Portal &amp; Bids is not built yet</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          This screen used to show sample distributor bids, RFQs and scorecards that were not
          real, and saved changes only in your browser. It has been taken down so nobody quotes
          a customer against a price no vendor ever offered.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          Everything you actually need to buy from a vendor already works:
        </p>
        <ul className="mt-4 space-y-2">
          <li>
            <Link
              href={"/accounting/vendors" as never}
              className="flex min-h-11 items-center gap-2 rounded-md border border-hairline px-3 py-2 text-sm font-medium text-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <Icon name="users" size={15} className="text-ink-3" />
              Vendors — add a vendor, see their ledger
            </Link>
          </li>
          <li>
            <Link
              href={"/purchase-orders" as never}
              className="flex min-h-11 items-center gap-2 rounded-md border border-hairline px-3 py-2 text-sm font-medium text-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <Icon name="cart" size={15} className="text-ink-3" />
              Purchase Orders — raise a PO to a vendor
            </Link>
          </li>
          <li>
            <Link
              href={"/accounting/bills" as never}
              className="flex min-h-11 items-center gap-2 rounded-md border border-hairline px-3 py-2 text-sm font-medium text-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <Icon name="receipt" size={15} className="text-ink-3" />
              COGS Bills — record what a vendor charged you
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}
