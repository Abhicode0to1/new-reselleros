/**
 * Offering a second thing — from the catalogue, and only from the catalogue.
 *
 * ─── THE BRIEF'S OWN EXAMPLE NAMES TWO PRODUCTS THAT DO NOT EXIST ───────────
 * It asks the agent to say: "Email Archiving Backup (₹49/mo) aur Professional Gmail Signature
 * Setup add kar sakte hain". Measured against this tenant's live `items` table on 25 Aug 2026:
 *
 *   · 25 items, ALL `kind = 'main'`, all active.
 *   · "Email Archiving Backup"            — does not exist.
 *   · "Professional Gmail Signature Setup" — does not exist.
 *   · ₹49                                  — is not the price of anything in the table.
 *
 * So the message in the brief offers two things we do not sell at a price we did not set. The
 * customer says yes, and then we either invent the product or take the offer back — and taking
 * an offer back is worse than never making it. This is the same failure as the ₹750 in the
 * telecalling brief, one step further along: there the price was wrong, here the PRODUCT is.
 *
 * ─── THERE ARE NO ADD-ONS TO SELL, AND THE FILTER SAYS WHY ──────────────────
 * `loadSalesCatalog` filters `kind = 'main'` precisely to keep add-ons out, and its comment
 * gives the reason: add-ons "are priced per-tenant-plan rather than per-seat and would be quoted
 * as seats if they reached the prompt". Since every row is currently `main`, that filter is a
 * no-op today — but the reason it exists is the design constraint this module has to respect.
 * ₹49 per seat per month across 30 seats is ₹17,640 a year. ₹49 per account is ₹588. One of
 * those numbers is wrong by thirty times and both look like a price.
 *
 * So a candidate carries its UNIT, and a candidate whose unit we cannot establish is not
 * offered at all. `PER_ACCOUNT` is inferred from the vendor rather than guessed per item — see
 * `unitFor`.
 *
 * ─── WHAT IS ACTUALLY SELLABLE TODAY, FROM THE REAL TABLE ───────────────────
 * The revenue lever the brief was reaching for exists; it is just not add-ons.
 *
 *   UPGRADE — Business Starter ₹270 → Standard ₹864 → Plus ₹1,380 → Enterprise ₹2,400 per seat
 *   per month, every one of them catalogued with a real wholesale cost. That is a real, priced,
 *   checkable conversation and it moves deal value further than a ₹49 add-on would.
 *
 *   ATTACH   — AppSheet Core (₹830 retail / ₹720 cost) is a genuine Google add-on that sits
 *   ALONGSIDE Workspace rather than replacing it. Support tiers likewise.
 *
 * ─── AND SEVEN ITEMS IN THIS CATALOGUE ARE UNOFFERABLE BY NAME ──────────────
 * `Basic` ₹250, `Free` ₹0, `Moderate` ₹667, `Premium` ₹1,667, `Standard` ₹125 (hosting),
 * `Starter` ₹50 (hosting), `Plus` ₹187 (hosting). Bare tier words, all `kind='main'`.
 *
 * `resolveItem` in quote-dispatcher.ts matches on EXACT NAME. So if the agent offered
 * "Standard" to a Workspace customer and they accepted, `leads.plan` becomes "Standard" and the
 * quote resolves to the ₹125 HOSTING product — not Workspace Standard at ₹864. A cross-sell
 * that lands on the wrong SKU is worse than no cross-sell, so `isOfferableName` refuses a bare
 * tier word outright. The names themselves are a commercial decision and are flagged in
 * TASKS.md rather than changed here.
 */
import { isBelowCost, type SalesCatalogEntry } from "@/lib/ai/sales-agent";

/* ── Units ────────────────────────────────────────────────────────────────── */

/** How a price multiplies. Getting this wrong is a thirty-times error that looks like a price. */
export type PricingUnit = "per_seat" | "per_account";

/**
 * Vendors whose items are priced ONCE for the whole account, not per seat.
 *
 * `support` and `hosting` in this catalogue: "Standard Support ₹999" is a tier the reseller
 * buys, not ₹999 × 30 people. Inferred from the vendor rather than the item, because a
 * per-item guess is a guess and the vendor is a recorded fact.
 */
const PER_ACCOUNT_VENDORS: readonly string[] = ["support", "hosting", "other"];

export function unitFor(entry: SalesCatalogEntry): PricingUnit {
  return PER_ACCOUNT_VENDORS.includes(entry.vendor.toLowerCase()) ? "per_account" : "per_seat";
}

/* ── Which names may be spoken ────────────────────────────────────────────── */

/**
 * Bare tier words that cannot identify a product on their own.
 *
 * Not a style rule. `resolveItem` matches exact names, so offering one of these can land the
 * quote on a different vendor's SKU entirely — "Standard" is both Workspace Standard (₹864
 * /seat/month) and a hosting plan (₹125). Same class of mistake as guessing a provider from an
 * unrecognised MX record: a confident sentence about the wrong thing.
 */
const BARE_TIER_WORDS: readonly string[] = [
  "free",
  "basic",
  "starter",
  "standard",
  "plus",
  "premium",
  "moderate",
  "enterprise",
  "professional",
  "advanced",
];

/** Can this item be named to a customer without ambiguity? */
export function isOfferableName(name: string): boolean {
  const words = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  /* A single word that is a tier name identifies nothing. Two or more words are taken as a real
     product name — "Google Workspace Business Standard" is unambiguous, "Standard" is not. */
  if (words.length === 1) return !BARE_TIER_WORDS.includes(words[0]);
  return true;
}

/* ── Telling a TIER from an ADD-ON ────────────────────────────────────────── */

/**
 * How many leading words two product names share.
 *
 * ─── PRICE CANNOT TELL AN ADD-ON FROM A TIER, AND TRYING PRODUCED A BUG ─────
 * The first version of this module classified an upgrade as "same vendor, per-seat, dearer than
 * what they have". A test caught what that does to AppSheet Core, which is ₹830/seat/month —
 * DEARER than Business Starter (₹270) and CHEAPER than Business Plus (₹1,380):
 *
 *   offered to a Starter customer → classified as an UPGRADE
 *   offered to a Plus customer    → classified as an ATTACH
 *
 * The same product, two different kinds, decided by what the customer happened to be buying. It
 * is not an upgrade in either case: AppSheet is a separate Google product that sits ALONGSIDE
 * Workspace, and telling a Starter customer to "upgrade" to it would offer them app-building
 * software instead of the mail they asked about.
 *
 * So the family comes from the NAME, which is a stable fact about the product, and never from
 * the price, which is a fact about the comparison. Two shared leading words is the bar:
 *
 *   "Google Workspace Business Starter" vs "…Business Standard"  → 3 shared → same family
 *   "Google Workspace Business Starter" vs "Google Workspace Enterprise" → 2 → same family
 *   "Google Workspace Business Starter" vs "AppSheet Core"       → 0 → not a tier of it
 */
function sharedLeadingWords(a: string, b: string): number {
  const wa = a.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const wb = b.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let n = 0;
  while (n < wa.length && n < wb.length && wa[n] === wb[n]) n += 1;
  return n;
}

/** Below this many shared leading words, two items are different products, not two tiers. */
const SAME_FAMILY_WORDS = 2;

/* ── Candidates ───────────────────────────────────────────────────────────── */

export type OfferKind =
  /** A bigger version of what they are already buying. Replaces the line. */
  | "upgrade"
  /** A separate thing that sits alongside. Adds a line. */
  | "attach";

export interface OfferCandidate {
  kind: OfferKind;
  name: string;
  vendor: string;
  unit: PricingUnit;
  /** Retail, whole rupees, per the unit above. Straight from the catalogue. */
  pricePerUnitPerYear: number;
  /** For an upgrade: the extra over what they already have. Zero for an attach. */
  stepUpPerUnitPerYear: number;
}

export interface CrossSellOptions {
  /** How many candidates to offer. Two, because a list of six is a list nobody reads. */
  max?: number;
}

const DEFAULT_MAX = 2;

/**
 * What else this customer could be offered, given what they are buying.
 *
 * ─── EVERY EXCLUSION HERE IS LOAD-BEARING ───────────────────────────────────
 * · The item they already have, obviously.
 * · Anything not in `catalog` — which is the whole point, and is why this function takes the
 *   catalogue rather than a list of ideas.
 * · Below-cost items, via the same `isBelowCost` the main path uses. An upsell that loses money
 *   is worse than no upsell, and `money-check.yml` exists because four products once shipped
 *   priced under their own vendor cost.
 * · Zero-priced items. "Free Support ₹0" is real in this table, and offering it as an upsell is
 *   offering nothing while sounding like an offer.
 * · Ambiguous names — see `isOfferableName`.
 * · A DIFFERENT VENDOR'S main plan. Offering Microsoft 365 to somebody buying Google Workspace
 *   is not a cross-sell, it is restarting the conversation.
 * · A SMALLER plan from the same family. That is a downgrade, and volunteering one is doing the
 *   customer's negotiating for them.
 */
export function offerCandidates(
  catalog: readonly SalesCatalogEntry[],
  current: { name: string; vendor: string; pricePerSeatPerYear: number },
  opts: CrossSellOptions = {},
): OfferCandidate[] {
  const max = Math.max(0, opts.max ?? DEFAULT_MAX);
  if (max === 0) return [];

  const currentVendor = current.vendor.trim().toLowerCase();

  const usable = catalog.filter(
    (c) =>
      c.name !== current.name &&
      c.msrpPerSeatPerYear > 0 &&
      !isBelowCost(c) &&
      isOfferableName(c.name),
  );

  const upgrades: OfferCandidate[] = usable
    .filter(
      (c) =>
        c.vendor.trim().toLowerCase() === currentVendor &&
        unitFor(c) === "per_seat" &&
        /* SAME FAMILY, by name. Not by price — see sharedLeadingWords for the bug that came
           from letting price decide it. */
        sharedLeadingWords(c.name, current.name) >= SAME_FAMILY_WORDS &&
        c.msrpPerSeatPerYear > current.pricePerSeatPerYear,
    )
    /* Nearest step up first. The next tier is a conversation; three tiers up is a different
       budget, and leading with it reads as not having listened. */
    .sort((a, b) => a.msrpPerSeatPerYear - b.msrpPerSeatPerYear)
    .map((c) => ({
      kind: "upgrade" as const,
      name: c.name,
      vendor: c.vendor,
      unit: unitFor(c),
      pricePerUnitPerYear: c.msrpPerSeatPerYear,
      stepUpPerUnitPerYear: c.msrpPerSeatPerYear - current.pricePerSeatPerYear,
    }));

  const attaches: OfferCandidate[] = usable
    .filter((c) => {
      const v = c.vendor.trim().toLowerCase();
      /* A per-account item (support, hosting) always attaches — it is never a seat tier. */
      if (unitFor(c) === "per_account") return true;
      /* Otherwise: same vendor, and NOT a tier of the same product family. That is what an
         add-on is — AppSheet Core beside Workspace — and it holds whatever the price does,
         which is the whole point of deciding this by name. */
      return v === currentVendor && sharedLeadingWords(c.name, current.name) < SAME_FAMILY_WORDS;
    })
    .sort((a, b) => a.msrpPerSeatPerYear - b.msrpPerSeatPerYear)
    .map((c) => ({
      kind: "attach" as const,
      name: c.name,
      vendor: c.vendor,
      unit: unitFor(c),
      pricePerUnitPerYear: c.msrpPerSeatPerYear,
      stepUpPerUnitPerYear: 0,
    }));

  /* One upgrade and one attach beats two of either: they answer different questions, and a
     customer shown two upgrades is being pushed rather than helped. */
  const picked: OfferCandidate[] = [];
  if (upgrades[0]) picked.push(upgrades[0]);
  if (attaches[0]) picked.push(attaches[0]);
  for (const c of [...upgrades.slice(1), ...attaches.slice(1)]) {
    if (picked.length >= max) break;
    picked.push(c);
  }

  return picked.slice(0, max);
}

/* ── What the agent may say about them ────────────────────────────────────── */

/**
 * The figures a draft may state because this module put them there. For the money guard.
 *
 * ─── A STEP-UP IS A DIFFERENCE, AND A DIFFERENCE CAN LAND ON OUR COST ───────
 * `stepUpPerUnitPerYear` is one retail price minus another. Nothing stops that arithmetic from
 * coming out exactly equal to a WHOLESALE figure in the same catalogue — and if it did, this
 * function would hand the money guard permission to approve a draft stating what we pay. The
 * rule that wholesale never enters `allowedMoney` is one of the oldest in this file's family
 * (see BuiltPrompt.allowedMoney), and "it is unlikely to collide" is not the same as "it
 * cannot".
 *
 * So the catalogue's own cost figures are subtracted from the result. The cost of that is one
 * step-up figure occasionally missing from the allow-list, which means the agent may state both
 * prices and not their difference — a sentence it was told not to compute anyway.
 *
 * @param catalog the same catalogue the candidates came from, for its wholesale figures.
 */
export function authorisedOfferFigures(
  candidates: readonly OfferCandidate[],
  catalog: readonly SalesCatalogEntry[] = [],
): number[] {
  const costs = new Set(
    catalog.map((c) => c.wholesalePerSeatPerYear).filter((n) => n > 0),
  );
  return candidates
    .flatMap((c) => [c.pricePerUnitPerYear, c.stepUpPerUnitPerYear])
    .filter((n) => n > 0 && !costs.has(n));
}

/**
 * The prompt block. Finished sentences, and an instruction to ASK rather than add.
 *
 * ─── AN OFFER IS A QUESTION, NEVER A LINE ON THE QUOTE ──────────────────────
 * The brief gets this right in its own example — "Kya main quotation mein yeh include kar du?"
 * — and it is worth stating as a rule rather than hoping the phrasing holds. A quotation that
 * silently gained a line the customer did not ask for is a document they will find later, and
 * the thing they will remember is not the add-on.
 *
 * Empty array when there is nothing to offer, so the prompt is unchanged in the ordinary case.
 */
export function offerLines(input: {
  candidates: readonly OfferCandidate[];
  seats: number | null;
}): string[] {
  if (input.candidates.length === 0) return [];

  const lines: string[] = [
    "WHAT ELSE THEY COULD BE OFFERED (from the catalogue — nothing else exists)",
  ];

  for (const c of input.candidates) {
    const unit = c.unit === "per_seat" ? "per seat per year" : "for the whole account per year";
    if (c.kind === "upgrade") {
      lines.push(
        `  - UPGRADE to ${c.name}: Rs ${c.pricePerUnitPerYear.toLocaleString("en-IN")} ${unit}` +
          ` — Rs ${c.stepUpPerUnitPerYear.toLocaleString("en-IN")} more ${unit} than what they asked for.`,
      );
    } else {
      lines.push(
        `  - ADD ${c.name}: Rs ${c.pricePerUnitPerYear.toLocaleString("en-IN")} ${unit}.`,
      );
    }
  }

  lines.push(
    "",
    "HOW TO OFFER IT:",
    "  - ASK. 'Shall I include it in the quotation?' — never add it and never assume a yes. A",
    "    quotation that silently gained a line is a document they find later, and the add-on is",
    "    not what they will remember about it.",
    "  - ONE mention, at the END, after you have answered what they actually asked. A customer",
    "    who asked a price question and got a sales pitch has been sold at, not helped.",
    "  - Say what it DOES in their terms, in one clause. If you cannot say what it does without",
    "    guessing, do not offer it.",
    "  - State the unit next to every figure, exactly as written above. Per-seat and",
    "    per-account differ by the seat count, and a figure without its unit is a number nobody",
    "    can check.",
    "  - NEVER name a product that is not in the list above, and never name a price that is not",
    "    beside it. If they ask for something we do not sell, say you will check.",
    "  - Do NOT total the upgrade or the add-on into the deal yourself. Give the figure and its",
    "    unit; the quotation does the arithmetic.",
  );

  if (input.seats !== null && input.seats > 0) {
    lines.push(
      "",
      `They are asking about ${input.seats} seats. A per-seat figure multiplies by that; a`,
      "per-account figure does not. Do not do either multiplication yourself.",
    );
  }

  return lines;
}
