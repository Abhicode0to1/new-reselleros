/**
 * What a screen is FOR, in one line, for AI Help (R-162, 5 Oct 2026).
 *
 * Seen on staging: on /accounting/google-bill-check the AI guessed the page was about "clients
 * billed but not charged by Google" — the opposite of its main job (domains Google charges that
 * nobody is billed for). It only had the URL. Now it gets the screen's name and hint from the
 * nav (one source of truth, already written for the sidebar tooltips), plus a few longer notes
 * for screens whose job a hint cannot carry.
 */
import { APP_NAV, flattenNav } from "@/lib/nav";

/** Screens that need more than a tooltip to be understood. Keep each to two sentences. */
const NOTES: Record<string, string> = {
  "/accounting/google-bill-check":
    "Upload Google's monthly Workspace invoice (bought through Net2Secure). Main job: match every domain Google charged to a customer — domains with no customer or no subscription are LEAKAGE (we pay Google, bill nobody); it also shows margin per domain, domains we bill that Google did not charge, and checks Net2Secure's bill (Google subtotal + ₹10 per user per year).",
  "/accounting/payment-runs":
    "Pay vendors in one batch: pick due bills (MSME 45-day bills first), create a run, owner/manager approves, download the bank bulk-upload CSV, pay in net-banking, then 'Bank paid it' marks every bill paid. ResellerOS never sends money.",
  "/admin/feedback":
    "Every bug report and idea from the team, triaged by AI, with a directive a coding agent can act on.",
};

export function pagePurpose(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const path = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  const note = Object.entries(NOTES).find(([p]) => path === p || path.startsWith(p + "/"))?.[1];
  // Longest nav href that this path sits under.
  const entry = flattenNav(APP_NAV)
    .filter(({ item }) => !item.external && (path === item.href || path.startsWith(item.href + "/")))
    .sort((a, b) => b.item.href.length - a.item.href.length)[0];
  const name = entry ? [entry.section.section, entry.parent?.label, entry.item.label].filter(Boolean).join(" › ") : null;
  const hint = entry?.item.hint ?? null;
  const parts = [name, note ?? hint].filter(Boolean);
  return parts.length ? parts.join(" — ") : null;
}
