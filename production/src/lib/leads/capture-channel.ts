/**
 * Which capture channel a raw `leads.source` belongs to (1 Oct 2026).
 *
 * Moved out of app/(app)/lead-gen/page.tsx unchanged, so the Lead Sources screen and the
 * dashboard's Company section group sources by the SAME rule — "from the website" on the
 * dashboard is exactly the "Website form" row on /lead-gen.
 *
 * The public flows write these sources, all of which land in "website":
 *   enquiry-form · buy-workspace · buy-workspace-v2 · buy-workspace-trial ·
 *   buy-workspace-direct(-sim) · buy-hosting-trial
 */
export function captureChannel(raw: string | null | undefined): string {
  const s = (raw ?? "manual").toLowerCase();
  if (s.includes("whatsapp")) return "whatsapp";
  if (s.includes("email")) return "email";
  if (s.startsWith("buy") || s.includes("website") || s.includes("form")) return "website";
  if (s.includes("referr")) return "referral";
  if (s.includes("linkedin")) return "linkedin";
  // Before the generic "ads" test below — meta-ads is a Facebook ad, not a Google one.
  if (s.includes("meta") || s.includes("facebook") || s.includes("instagram")) return "facebook";
  if (s.includes("indiamart") || s.includes("justdial")) return "marketplace";
  if (s.includes("google-organic")) return "seo";   // found us on Google, no ad
  if (s.includes("cold") || s.includes("apollo") || s.includes("lemlist")) return "cold";
  if (s.includes("google") || s.includes("ads") || s.includes("adword")) return "ads";
  if (s.includes("csv") || s.includes("import")) return "import";
  if (s.includes("manual")) return "manual";
  return s;
}
