/**
 * A plan name short enough for a table cell, without making two products look like one.
 *
 * ─── WHY NOT JUST DROP THE VENDOR ───────────────────────────────────────────
 * The leads table clipped "Google Workspace Business Starter" to "Google Workspace Bus…",
 * spending its width on seventeen characters every row shares. The obvious fix is to strip
 * the vendor — and it is wrong. This tenant's catalogue holds all three of:
 *
 *     Google Workspace Business Standard
 *     Microsoft 365 Business Standard
 *     Zoho Workplace Standard
 *
 * Strip the vendor and the first two both read "Business Standard", on a page where every
 * row carries a rupee figure. There is a bare "Standard" in the catalogue too. Three
 * different products, one label, on a money screen.
 *
 * So the vendor is SHORTENED, never removed: "GW · Business Standard" is 22 characters
 * against 34, and still says which vendor's Standard it is.
 *
 * ─── AND WHY THE LIST IS CLOSED ─────────────────────────────────────────────
 * An unknown plan comes back untouched. A regex that guessed at "first two words are the
 * vendor" would turn "Custom Software Development" into "CS · Development" — the catalogue
 * really does contain that, along with "ANUTECH DIGITAL PVT LTD Standard Support". Only
 * names this file recognises are rewritten.
 */

/** Vendor prefixes worth shortening, longest first so "Google Workspace" wins over "Google". */
const VENDORS: readonly (readonly [string, string])[] = [
  ["Google Workspace", "GW"],
  ["Microsoft 365", "M365"],
  ["Zoho Workplace", "Zoho"],
];

/**
 * "Google Workspace Business Starter" → "GW · Business Starter".
 * Anything this file does not recognise is returned exactly as given.
 */
export function shortPlan(plan: string | null | undefined): string {
  const name = (plan ?? "").trim();
  if (!name) return "";

  for (const [full, short] of VENDORS) {
    if (name.toLowerCase().startsWith(full.toLowerCase())) {
      const rest = name.slice(full.length).trim();
      /* A plan that is ONLY the vendor keeps its full name — "GW · " reads as broken. */
      return rest ? `${short} · ${rest}` : name;
    }
  }
  return name;
}

/** Whether `shortPlan` would change this name — the cell only needs a tooltip when it does. */
export function planWasShortened(plan: string | null | undefined): boolean {
  const name = (plan ?? "").trim();
  return name.length > 0 && shortPlan(name) !== name;
}
