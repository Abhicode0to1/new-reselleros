"use client";
/**
 * The sticky title bar of Sales & Pipeline — title opposite the primary action. Moved
 * verbatim out of (app)/leads/page.tsx (S35, 28 Sep 2026). The fixed-height wrapper it
 * sits in stays in the page, because the two notes below are about BOTH together.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";

export interface LeadsHeaderBarProps {
  salesTab: "raw" | "deals" | "all";
  /** /deals gets its own title — it holds only real deals (quote → won / lost). */
  isDealsPage?: boolean;
  setAddOpen: (open: boolean) => void;
  /** Opens the 4-field Quick add (R-099). Leads page only — /deals adds deals, not raw leads. */
  setQuickOpen?: (open: boolean) => void;
}

export function LeadsHeaderBar({ salesTab, isDealsPage = false, setAddOpen, setQuickOpen }: LeadsHeaderBarProps) {
  return (
    <>
      {/* Top App Bar — sticky, so the primary action never scrolls away.
          TWO rows on purpose. It used to be one `flex-wrap` row holding title +
          switcher + CTA; below ~640px the CTA wrapped onto a line of its own and
          landed bottom-LEFT, which is the opposite of a primary action. Pinning
          the title and the CTA together in row 1 keeps "Add Lead" in the
          top-right corner at every width.

          `top-14` and `z-20` are BOTH load-bearing. The app's own TopBar is
          `sticky top-0 z-30 h-14` (components/layout/topbar.tsx). A first attempt
          used `top-0 z-30` here — the same offset and the same z-index — so this
          bar stuck to the viewport top ON TOP OF the TopBar (equal z-index, and
          this element comes later in the DOM, so it won). `top-14` parks it flush
          under the 56px TopBar; `z-20` guarantees it can never paint over it even
          if the offsets are edited again later. */}
      {/* Two things above are load-bearing together; changing either alone
          breaks this header.

          1. The wrapper's height subtracts the TopBar (3.5rem) AND, below md,
             the 4rem `pb-16` that (app)/layout.tsx puts on <main> for the mobile
             bottom nav. Without that second term the page is 4rem taller than
             the space it was given, so the DOCUMENT scrolls even though this
             page is meant to be contained. Fixed here, not in the layout,
             because pb-16 is right for every page that genuinely scrolls.

          2. top-0, not top-14. `overflow-hidden` on that wrapper makes IT the
             sticky containing block, not the viewport — so this offset is
             measured from the wrapper's top edge, which already sits below the
             TopBar. top-14 added the TopBar's 56px a second time and pinned
             this header 56px below its own content: the empty band under the
             TopBar. top-14 only looked necessary while the document was
             scrolling, which (1) stops. */}
      <div className="sticky top-0 z-20 shrink-0 mb-2.5 -mx-3 sm:-mx-4 px-3 sm:px-4 pt-1.5 pb-1.5 bg-paper/95 backdrop-blur-sm border-b border-hairline/60">
        {/* Row 1 — title, opposite the primary action */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="min-w-0">
            <h1 className="font-serif text-xl sm:text-2xl font-bold leading-none text-ink truncate">
              {isDealsPage ? "Deals" : "Sales & Pipeline"}
            </h1>
            {isDealsPage && (
              <p className="mt-1 text-xs text-ink-3 truncate">Quote Sent to Won</p>
            )}
          </div>

          {/* Primary action — top-right, and sticky with this bar. Quick add sits beside it
              (Pardeep, 2 Oct 2026: the phone-is-enough form should be on this page, not only
              behind the top-bar panel and Ctrl+K). */}
          <div className="flex shrink-0 items-center gap-2">
          {!isDealsPage && setQuickOpen && (
            <Button size="sm" icon="zap" onClick={() => setQuickOpen(true)}>
              Quick add
            </Button>
          )}
          <Button
            variant="primary"
            icon="plus"
            size="sm"
            className="shrink-0"
            onClick={() => setAddOpen(true)}
          >
            {salesTab === "raw" ? "Add lead" : "Add deal"}
          </Button>
          </div>
        </div>


      </div>
    </>
  );
}
