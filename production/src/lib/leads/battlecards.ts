/**
 * Objection battlecards — what to say when a customer pushes back.
 *
 * ─── WHY THIS IS WRITTEN DOWN AND NOT GENERATED ─────────────────────────────
 * The brief filed this under "AI Co-Pilot". It is not an AI problem. A battlecard is a
 * position the BUSINESS takes — what this reseller claims about migration effort, about
 * support response, about pricing — and a model asked to invent one will produce
 * confident, plausible, unverifiable claims for a rep to repeat to a customer.
 *
 * That is the worst possible place for the failure mode this codebase keeps hitting: a
 * made-up answer that reads like a real one. A wrong margin costs money; a wrong claim
 * about data residency or a migration guarantee is something a customer can hold you to.
 *
 * So these are written, reviewable, and version-controlled. When Pardeep disagrees with
 * one, it is a one-line edit with his name on the commit rather than a prompt nobody can
 * audit.
 *
 * ─── AND WHAT THEY DELIBERATELY DO NOT DO ───────────────────────────────────
 * No card quotes a price, a discount, or a delivery date. Those change, they are
 * per-customer, and a stale number in a battlecard is a promise a rep makes without
 * knowing it is stale. Cards handle POSITIONING; the quote handles numbers.
 */

export type BattlecardVendor = "google" | "microsoft" | "zoho";

export interface Battlecard {
  /** The objection, in the customer's own words. */
  objection: string;
  /** What to say. Short enough to read mid-call. */
  response: string;
  /** Optional: what NOT to say, where there is a known trap. */
  avoid?: string;
}

export interface VendorBattlecards {
  vendor: BattlecardVendor;
  label: string;
  /** One line on where this vendor genuinely wins — reps oversell otherwise. */
  strength: string;
  cards: Battlecard[];
}

export const BATTLECARDS: readonly VendorBattlecards[] = [
  {
    vendor: "google",
    label: "Google Workspace",
    strength: "Fastest to set up, and the one people already know how to use from Gmail.",
    cards: [
      {
        objection: "Microsoft 365 is cheaper.",
        response:
          "On the entry plan it often is. Compare what you actually need: if the team lives in Excel and needs the desktop apps, Microsoft is the honest answer. If they work in a browser and share documents constantly, Workspace is less to administer and less to train.",
        avoid: "Do not claim Workspace is cheaper across the board — on a like-for-like comparison it frequently is not, and the customer will check.",
      },
      {
        objection: "We already have Office files everywhere.",
        response:
          "Workspace opens and saves Office formats directly — no conversion step. Ask which files matter most and open one during the demo rather than describing it.",
      },
      {
        objection: "Where is our data stored?",
        response:
          "Google publishes its data-region commitments and offers a data-region policy on the higher tiers. Send them the current Google documentation rather than paraphrasing it.",
        avoid: "Never state a specific country or guarantee residency from memory. If they need it in writing, get it from the vendor documentation.",
      },
    ],
  },
  {
    vendor: "microsoft",
    label: "Microsoft 365",
    strength: "Desktop Office, Teams, and the compliance tooling larger buyers ask for by name.",
    cards: [
      {
        objection: "Google is simpler.",
        response:
          "For pure email, yes. Microsoft earns its complexity when you need desktop Excel, Teams as the company's phone system, or the compliance and retention controls. Ask which of those they actually use before conceding the point.",
      },
      {
        objection: "Too many plans — we do not know which one.",
        response:
          "Three questions settle it: do they need desktop Office, do they need Teams calling, do they need compliance or archiving. That maps to Basic, Standard or Premium without a comparison table.",
      },
      {
        objection: "We want to cancel mid-term.",
        response:
          "Microsoft NCE commits the term. Seats can be added at any time, but not reduced, and cancellation is only possible in the first 7 days. Say this BEFORE the sale, not after — the app enforces the same window.",
        avoid: "Do not promise mid-term reductions. The subscription code blocks them because Microsoft does.",
      },
    ],
  },
  {
    vendor: "zoho",
    label: "Zoho",
    strength: "Lowest cost per seat, Indian company, and the wider suite if they grow into it.",
    cards: [
      {
        objection: "Nobody has heard of Zoho.",
        response:
          "It is an Indian company with a long track record and a large customer base here. For a price-sensitive team that mainly needs mail and documents, it does the job for materially less.",
      },
      {
        objection: "Will it work with our existing tools?",
        response:
          "Check the specific integrations they name rather than answering in general. Zoho's own suite connects tightly; third-party coverage is thinner than Google's or Microsoft's, and saying so builds more trust than discovering it later.",
        avoid: "Do not claim parity of integrations with Google or Microsoft. It is not true and it surfaces during implementation.",
      },
    ],
  },
];

export function battlecardsFor(vendor: BattlecardVendor | null | undefined): VendorBattlecards | null {
  if (!vendor) return null;
  return BATTLECARDS.find((b) => b.vendor === vendor) ?? null;
}

/**
 * Guess the vendor from a plan name, for pre-selecting a card set.
 *
 * Returns null rather than a default when the plan does not name a vendor — opening the
 * Google cards for a Zoho deal would put the wrong words in a rep's mouth, which is
 * worse than making them pick.
 */
export function vendorFromPlan(plan: string | null | undefined): BattlecardVendor | null {
  const p = (plan ?? "").toLowerCase();
  if (!p.trim()) return null;
  if (p.includes("google") || p.includes("workspace") || p.includes("gws")) return "google";
  if (p.includes("microsoft") || p.includes("365") || p.includes("office")) return "microsoft";
  if (p.includes("zoho")) return "zoho";
  return null;
}
