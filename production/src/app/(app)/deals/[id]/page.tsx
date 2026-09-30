/**
 * /deals/[id] — the deal detail page (30 Sep 2026). Thin wrapper: the page lives in
 * components/features/deals/deal-detail-view.tsx. Role gating is the same as /deals —
 * middleware's prefix match on allowedRoutesForRole covers /deals/<id>, and the view
 * re-checks lib/deals/access.ts#canSeeDeals on the client.
 */
"use client";

import { useParams } from "next/navigation";
import { DealDetailView } from "@/components/features/deals/deal-detail-view";

export default function DealDetailPage() {
  const params = useParams<{ id: string }>();
  return <DealDetailView leadId={decodeURIComponent(params.id)} />;
}
