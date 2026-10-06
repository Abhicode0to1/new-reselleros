import type { Route } from "next";
import { redirect } from "next/navigation";
import { LP_PLANS } from "@/site/lib/lp-plans";

/**
 * /lp/google-workspace — the first ad page (R-139). Since 4 Oct 2026 every plan has its own
 * page, and this one is "Business Starter — Landing Page 1". Old ads and links still land
 * here, so forward them with the query string intact (gclid / utm must survive the hop).
 */
export default async function OldWorkspaceLanding({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null) qs.set(k, v);
  }
  const q = qs.toString();
  redirect((LP_PLANS.starter.path + (q ? `?${q}` : "")) as Route);
}
