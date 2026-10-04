import type { Metadata } from "next";
import { WorkspaceAdLanding } from "@/site/components/lp/WorkspaceAdLanding";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";
import { LP_PLANS, type LpPlanKey } from "@/site/lib/lp-plans";

/**
 * Shared body of the per-plan Google Ads landing pages under (lp)/lp/ (4 Oct 2026). The price
 * is the live catalogue's yearly rate for the plan — the same figure checkout charges (falls
 * back to LICENCE_EDITIONS if the catalogue is down). Enterprise has no list price: talk to us.
 */
export function lpPlanMetadata(key: LpPlanKey): Metadata {
  const plan = LP_PLANS[key];
  return {
    title: `Google Workspace ${plan.name}`,
    description: `Google Workspace ${plan.name} by ANUTECH Digital — ${plan.storage}, ${plan.meetPeople.toLowerCase()} meetings, professional email. 14-day free trial, GST invoice, setup and migration included.`,
  };
}

export async function LpPlanPage({ planKey }: { planKey: LpPlanKey }) {
  const plan = LP_PLANS[planKey];
  let price: number | null = null;
  if (plan.edition) {
    const editions = mergeEditions(await fetchLiveWorkspace());
    const ed = editions.find((e) => e.name === plan.edition);
    price = ed?.annual && ed.annual > 0 ? ed.annual : null;
  }
  return <WorkspaceAdLanding plan={plan} annualPerSeatMo={price} />;
}
