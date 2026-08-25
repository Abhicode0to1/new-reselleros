/**
 * Objection battlecards — what the agent may say when a customer pushes back.
 *
 * Pure. Cards are INSTRUCTIONS, not scripts: the agent writes the words with the usual guards
 * on them. A fixed paragraph read back to a customer who raised the objection differently is
 * how a salesperson stops sounding like one, and the same reasoning shaped the cadence steps.
 *
 * ─── EVERY CARD CLAIMS THINGS ABOUT US, NEVER ABOUT THEM ────────────────────
 * That constraint is the design. The battlecards as briefed contained three claims about other
 * people's products, and each one is either unverifiable or wrong:
 *
 *   1. "Direct Google par ... GST invoice lagne mein dikkat aati hai." Google bills Indian
 *      customers through Google Cloud India Pvt Ltd against an Indian GSTIN — ordinary GST,
 *      ordinary input tax credit. lib/pricing/net-cost.ts refuses this exact claim and explains
 *      why at length; repeating it here would break that guard from the other side.
 *   2. "Direct Google par local phone support nahi milta." Paid Workspace plans include
 *      support. What is TRUE is a fact about us — a named local team, Indian hours, Hindi or
 *      English — and that is what the card says.
 *   3. "Zoho basic email ke liye achha hai." Zoho Mail is not basic, Zoho has Meeting and
 *      Writer has co-editing, and — the part that matters commercially — WE RESELL ZOHO.
 *      Workplace Standard at ₹120 and Professional at ₹280 are in this catalogue at ~21%
 *      margin. Talking a customer out of Zoho is talking them out of a sale we earn on.
 *
 * ─── AND THE ZOHO ANSWER IN THE CATALOGUE IS BETTER THAN DISPARAGEMENT ──────
 * Measured 25 Aug 2026: Zoho Workplace Professional is ₹280/seat/month and Google Workspace
 * Business Starter is ₹270. So "Zoho cheaper hai" is answerable with arithmetic the customer
 * can check — the two are within ten rupees — instead of an opinion about somebody else's
 * product. `priceAnchor` builds that line from `items` at call time, so it cannot go stale.
 *
 * It is also the better sale: Starter carries 59.3% margin against Zoho Professional's 21.4%.
 * Worth stating out loud because it means the honest answer and the profitable answer are the
 * same one here, which is not always true and is worth knowing when it is.
 *
 * ─── NOTHING OFFERS A DOCUMENT THAT DOES NOT EXIST ──────────────────────────
 * The brief's Zoho card ended "Kya main dono ka side-by-side feature comparison sheet
 * bhejoon?". There is no comparison sheet anywhere in this app — checked. An agent offering
 * one would be promising a document nobody can then send, which is worse than not offering:
 * the customer says yes and we go quiet. Cards that need collateral declare it, and the caller
 * omits them until the collateral exists — the same rule the cadence's day-4 value step follows.
 */
import type { SalesCatalogEntry } from "./sales-agent";

export type ObjectionId =
  | "cheaper_elsewhere"
  | "buy_direct"
  | "too_expensive"
  | "thinking_about_it";

export interface Battlecard {
  id: ObjectionId;
  /** What the customer said, roughly, for the log and the operator's screen. */
  objection: string;
  /**
   * Lowercase cues. Matched as whole words against the customer's message — see
   * `detectObjections`. Deliberately short: a long cue list matches accidentally, and a card
   * fired on the wrong objection answers a question nobody asked.
   */
  cues: readonly string[];
  /** What the agent should DO. An instruction, not a script. */
  strategy: string;
  /** Facts about us it may state. */
  mayClaim: readonly string[];
  /** Named explicitly, because the model's instinct is to reach for exactly these. */
  mustNotClaim: readonly string[];
  /** True when the card cannot be used until the reseller has real collateral. */
  requiresCollateral?: boolean;
}

export const BATTLECARDS: readonly Battlecard[] = [
  {
    id: "cheaper_elsewhere",
    objection: "Another vendor — usually Zoho — is cheaper",
    cues: ["zoho", "cheaper", "sasta", "kam price", "kam daam"],
    strategy:
      "Do NOT argue against the other product. Ask what they actually need it for — how many " +
      "people, whether they run video calls, whether two people edit the same document — and " +
      "then compare the two products AT THE SAME PRICE POINT using the prices given to you. " +
      "If what they described is genuinely served by the cheaper product, say so and quote it: " +
      "we sell it too.",
    mayClaim: [
      "the per-seat prices in the catalogue you were given, for either product",
      "that we resell both, so the recommendation is not a sales preference",
      "what is included in each plan, factually and without comparison adjectives",
    ],
    mustNotClaim: [
      "that the other product is 'basic', limited, or only good for email",
      "that the other product lacks video meetings or document co-editing — it has both",
      "any feature comparison you were not given in writing",
    ],
  },
  {
    id: "buy_direct",
    objection: "They would rather buy direct from the vendor",
    cues: ["direct", "seedha", "google se", "khud le", "vendor se"],
    strategy:
      "Say what buying through us adds, in facts about US. Do not tell them what the vendor " +
      "does or does not provide — you do not know which entity would invoice them, what their " +
      "support tier includes, or what their card charges. Offer the concrete thing instead: a " +
      "named person on Indian hours and an Indian tax invoice they can claim against.",
    mayClaim: [
      "support from a named local team in India, in the same time zone, in Hindi or English",
      "an Indian GST tax invoice issued against their GSTIN, so the tax is claimable",
      "billing in rupees, so no foreign-currency conversion on their card",
      "one point of contact for renewals, seat changes and migration",
    ],
    mustNotClaim: [
      "that the vendor does not issue a GST invoice, or that claiming tax from them is difficult",
      "that the vendor provides no phone support",
      "anything about reverse charge, import of service, or the vendor's invoicing entity",
      "what a foreign card transaction would cost them",
    ],
  },
  {
    id: "too_expensive",
    objection: "It costs more than they expected",
    cues: ["expensive", "mehnga", "budget", "zyada hai", "afford"],
    strategy:
      "Two honest moves, in this order. First, restate the NET cost after the input tax credit " +
      "they can claim — the figures you were given already do that, and most buyers are " +
      "comparing a GST-inclusive number with an exclusive one. Second, offer the tier that " +
      "actually fits: a smaller plan is a real answer and we earn on it.",
    mayClaim: [
      "the net-cost figures you were given",
      "the volume rate card, by seat count, exactly as written",
      "a lower tier from the catalogue, at its catalogue price",
    ],
    mustNotClaim: [
      "a discount that is not on the volume rate card",
      "that the price is going up, or that this price is about to expire",
      "any 'special' or 'one-time' price — there is no such thing",
    ],
  },
  {
    id: "thinking_about_it",
    objection: "They want time to decide",
    cues: ["thinking", "soch", "later", "baad me", "discuss", "team se"],
    strategy:
      "Agree, and make the next step small. Ask what would help the decision — a walkthrough, " +
      "a question answered, another person on a call. Do not manufacture urgency: the quote's " +
      "own expiry date is the only deadline that exists, and the volume rate is a published " +
      "rate card that does not expire.",
    mayClaim: [
      "the quote's own expiry date, as given to you",
      "that the rate card is published and the per-seat rate is not going away",
    ],
    mustNotClaim: [
      "that the price will rise, or that a discount is about to be withdrawn",
      "that stock, seats or an offer are limited",
    ],
  },
];

/**
 * Which objections this message raises.
 *
 * Whole-word matching, and that is not fussiness — it is the fix `extractEntities` needed on
 * 24 Aug, when a bare "Standard" matched an 8-character hosting SKU and priced a real
 * customer's quote from the wrong product. A substring cue like "soch" inside another word
 * would fire the wrong card just as quietly.
 *
 * Returns every match rather than a best guess. "Zoho sasta hai aur main direct bhi le sakta
 * hoon" is two objections, and answering one of them reads as not listening.
 */
export function detectObjections(message: string): Battlecard[] {
  /* Punctuation to spaces, runs collapsed, and the whole thing padded — so a cue padded the
     same way matches only on word boundaries. Works for a single word and for "kam price"
     alike, which is why there is no separate multi-word branch: the first version of this line
     had one, joined by an `&&` that bound tighter than the `||` beside it and made the
     condition mean something other than it read. */
  const text = ` ${message.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()} `;
  return BATTLECARDS.filter((card) => card.cues.some((cue) => text.includes(` ${cue} `)));
}

export interface PriceAnchor {
  /** The competitor product the customer named, as it appears in our catalogue. */
  theirs: { name: string; perSeatPerYear: number };
  /** Our closest-priced alternative. */
  ours: { name: string; perSeatPerYear: number };
}

/**
 * Our nearest-priced product to one the customer named, both from the catalogue.
 *
 * This is what replaces "Zoho basic email ke liye achha hai". Measured on this catalogue, Zoho
 * Professional and Google Workspace Business Starter are within ten rupees a month of each
 * other — so the answer to "Zoho is cheaper" is a comparison the customer can verify, not an
 * opinion about a product we also sell.
 *
 * Both figures come from `items` at call time, so the anchor cannot go stale the way a written
 * comparison would. Returns null when the named product is not in the catalogue, or when there
 * is nothing else to compare it with — better silent than confidently anchored to nothing.
 */
export function priceAnchor(
  catalogue: readonly SalesCatalogEntry[],
  namedVendor: string,
): PriceAnchor | null {
  const vendor = namedVendor.trim().toLowerCase();
  if (!vendor) return null;

  const theirs = catalogue
    .filter((c) => c.vendor.toLowerCase() === vendor && c.msrpPerSeatPerYear > 0)
    /* Their DEAREST plan, because that is the one a "cheaper" comparison is usually reaching
       for — anchoring on their cheapest would flatter us and mislead the customer. */
    .sort((a, b) => b.msrpPerSeatPerYear - a.msrpPerSeatPerYear)[0];
  if (!theirs) return null;

  const ours = catalogue
    .filter((c) => c.vendor.toLowerCase() !== vendor && c.msrpPerSeatPerYear > 0)
    .sort(
      (a, b) =>
        Math.abs(a.msrpPerSeatPerYear - theirs.msrpPerSeatPerYear) -
        Math.abs(b.msrpPerSeatPerYear - theirs.msrpPerSeatPerYear),
    )[0];
  if (!ours) return null;

  return {
    theirs: { name: theirs.name, perSeatPerYear: theirs.msrpPerSeatPerYear },
    ours: { name: ours.name, perSeatPerYear: ours.msrpPerSeatPerYear },
  };
}

/**
 * The battlecard block for the prompt, or null when the message raised no objection.
 *
 * `hasCollateral` gates the cards that need something to send. Nothing in this app can produce
 * a feature-comparison sheet, so until one exists those cards are omitted rather than offering
 * a document that will never arrive.
 */
export function battlecardLines(input: {
  message: string;
  catalogue: readonly SalesCatalogEntry[];
  hasCollateral?: boolean;
}): string[] | null {
  const cards = detectObjections(input.message).filter(
    (c) => !c.requiresCollateral || input.hasCollateral === true,
  );
  if (cards.length === 0) return null;

  const lines: string[] = [];

  for (const card of cards) {
    lines.push(`OBJECTION: ${card.objection}`);
    lines.push(`  Do this: ${card.strategy}`);
    lines.push("  You may state:");
    for (const c of card.mayClaim) lines.push(`    - ${c}`);
    lines.push("  You must NOT state:");
    for (const c of card.mustNotClaim) lines.push(`    - ${c}`);

    if (card.id === "cheaper_elsewhere") {
      /* The arithmetic that replaces the opinion. Only when the customer named a vendor we
         actually carry — otherwise there is nothing to anchor against and the card falls back
         to asking what they need. */
      const named = ["zoho", "microsoft", "google"].find((v) =>
        input.message.toLowerCase().includes(v),
      );
      const anchor = named ? priceAnchor(input.catalogue, named) : null;
      if (anchor) {
        lines.push(
          `  Price anchor, from our own catalogue: ${anchor.theirs.name} is ` +
          `Rs ${anchor.theirs.perSeatPerYear.toLocaleString("en-IN")} per seat per year and ` +
          `${anchor.ours.name} is Rs ${anchor.ours.perSeatPerYear.toLocaleString("en-IN")}. ` +
          "State both figures; let the customer draw the conclusion.",
        );
      }
    }
  }

  return lines;
}
