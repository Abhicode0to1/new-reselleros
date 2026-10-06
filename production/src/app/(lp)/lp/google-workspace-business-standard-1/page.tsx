import { LpPlanPage, lpPlanMetadata } from "@/site/lib/lp-plan-page";

/** /lp/google-workspace-business-standard-1 — Google Ads landing page 1 for this plan (lib/lp-plans.ts). noindex via (lp)/layout. */
export const metadata = lpPlanMetadata("standard");
export const revalidate = 600;

export default function Page() {
  return <LpPlanPage planKey="standard" />;
}
