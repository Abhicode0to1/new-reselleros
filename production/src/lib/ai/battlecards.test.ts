import { describe, it, expect } from "vitest";
import {
  BATTLECARDS,
  battlecardLines,
  detectObjections,
  priceAnchor,
} from "./battlecards";
import type { SalesCatalogEntry } from "./sales-agent";

/* The live catalogue, per seat per YEAR (msrp × 12), measured 25 Aug 2026. Zoho Professional
   and Google Workspace Business Starter are within ten rupees a MONTH of each other — the fact
   the Zoho card is built on. */
const CATALOGUE: SalesCatalogEntry[] = [
  { sku: "GW-STR", name: "Google Workspace Business Starter",  vendor: "google",    msrpPerSeatPerYear: 3_240,  wholesalePerSeatPerYear: 1_320 },
  { sku: "GW-STD", name: "Google Workspace Business Standard", vendor: "google",    msrpPerSeatPerYear: 10_368, wholesalePerSeatPerYear: 7_440 },
  { sku: "ZW-STD", name: "Zoho Workplace Standard",            vendor: "zoho",      msrpPerSeatPerYear: 1_440,  wholesalePerSeatPerYear: 1_140 },
  { sku: "ZW-PRO", name: "Zoho Workplace Professional",        vendor: "zoho",      msrpPerSeatPerYear: 3_360,  wholesalePerSeatPerYear: 2_640 },
  { sku: "M365-BS", name: "Microsoft 365 Business Standard",   vendor: "microsoft", msrpPerSeatPerYear: 11_880, wholesalePerSeatPerYear: 9_840 },
];

describe("detectObjections", () => {
  it("catches the Zoho objection as written", () => {
    const cards = detectObjections("Zoho cheaper hai, main Zoho le raha hu");
    expect(cards.map((c) => c.id)).toContain("cheaper_elsewhere");
  });

  it("catches the buy-direct objection as written", () => {
    const cards = detectObjections("Main Direct Google se khareed lunga");
    expect(cards.map((c) => c.id)).toContain("buy_direct");
  });

  it("returns BOTH when the customer raises two", () => {
    /* "Zoho sasta hai aur main direct bhi le sakta hoon" is two objections, and answering one
       of them reads as not listening. */
    const cards = detectObjections("Zoho sasta hai aur main direct bhi le sakta hoon");
    expect(cards.map((c) => c.id).sort()).toEqual(["buy_direct", "cheaper_elsewhere"]);
  });

  it("matches on whole words only", () => {
    /* The fix extractEntities needed on 24 Aug, when a bare "Standard" matched an 8-character
       hosting SKU and priced a real customer's quote from the wrong product. A substring cue
       fires the wrong card just as quietly. "sochta" is not "soch". */
    expect(detectObjections("Zohomail ka koi plan hai?").map((c) => c.id)).not.toContain("cheaper_elsewhere");
    expect(detectObjections("Directory sync chahiye").map((c) => c.id)).not.toContain("buy_direct");
  });

  it("survives punctuation and mixed case", () => {
    expect(detectObjections("ZOHO, cheaper?!").map((c) => c.id)).toContain("cheaper_elsewhere");
  });

  it("finds nothing in a plain enquiry", () => {
    expect(detectObjections("15 log ke liye Google Workspace chahiye, kitna lagega?")).toEqual([]);
  });
});

describe("every card claims things about US, never about them", () => {
  it("never lets the agent say the vendor cannot issue a GST invoice", () => {
    /* THE CLAIM THIS FILE REFUSES. Google bills Indian customers through Google Cloud India
       Pvt Ltd against an Indian GSTIN — ordinary GST, ordinary ITC. lib/pricing/net-cost.ts
       refuses this same claim; repeating it here would break that guard from the other side. */
    const card = BATTLECARDS.find((c) => c.id === "buy_direct")!;
    expect(card.mustNotClaim.join(" ")).toContain("does not issue a GST invoice");
    expect(card.mustNotClaim.join(" ")).toContain("reverse charge");
    expect(card.strategy).toContain("facts about US");
  });

  it("never lets the agent say the vendor has no phone support", () => {
    /* Paid Workspace plans include support. What is true is a fact about us. */
    const card = BATTLECARDS.find((c) => c.id === "buy_direct")!;
    expect(card.mustNotClaim.join(" ")).toContain("no phone support");
    expect(card.mayClaim.join(" ")).toContain("named local team");
  });

  it("never lets the agent call a product we resell 'basic'", () => {
    /* We sell Zoho — Workplace Standard and Professional are both in this catalogue at ~21%
       margin. Talking a customer out of Zoho is talking them out of a sale we earn on. */
    const card = BATTLECARDS.find((c) => c.id === "cheaper_elsewhere")!;
    expect(card.mustNotClaim.join(" ")).toContain("'basic'");
    expect(card.mustNotClaim.join(" ")).toContain("video meetings or document co-editing");
    expect(card.strategy).toContain("we sell it too");
  });

  it("manufactures no urgency anywhere", () => {
    /* A volume slab is a published rate card, not an expiring offer, and the only real deadline
       is the quote's own date. Both urgency cards say so. */
    for (const id of ["too_expensive", "thinking_about_it"] as const) {
      const card = BATTLECARDS.find((c) => c.id === id)!;
      expect(card.mustNotClaim.join(" ")).toMatch(/about to expire|about to be withdrawn|price will rise|price is going up/);
    }
  });

  it("offers no discount outside the rate card", () => {
    const card = BATTLECARDS.find((c) => c.id === "too_expensive")!;
    expect(card.mustNotClaim.join(" ")).toContain("not on the volume rate card");
    expect(card.mustNotClaim.join(" ")).toContain("'special'");
  });
});

describe("priceAnchor — arithmetic instead of an opinion", () => {
  it("puts Zoho Professional next to Google Workspace Starter", () => {
    /* This is what replaces "Zoho basic email ke liye achha hai". ₹3,360 against ₹3,240 a year
       — the customer can check it, and nobody has been disparaged. */
    const a = priceAnchor(CATALOGUE, "zoho");
    expect(a?.theirs.name).toBe("Zoho Workplace Professional");
    expect(a?.ours.name).toBe("Google Workspace Business Starter");
    expect(a?.theirs.perSeatPerYear).toBe(3_360);
    expect(a?.ours.perSeatPerYear).toBe(3_240);
  });

  it("anchors on their DEAREST plan, not their cheapest", () => {
    /* Anchoring on Zoho Standard (₹1,440) would flatter us and mislead the customer — a
       "cheaper" comparison is usually reaching for the plan that competes. */
    expect(priceAnchor(CATALOGUE, "zoho")?.theirs.perSeatPerYear).toBe(3_360);
  });

  it("reads both figures from the catalogue, so it cannot go stale", () => {
    /* A written comparison sheet would be right the day it was made. This is recomputed from
       `items` at call time — AGENTS.md L106, the whole reason no price lives in a source file. */
    const cheaper = CATALOGUE.map((c) =>
      c.sku === "GW-STR" ? { ...c, msrpPerSeatPerYear: 2_000 } : c,
    );
    expect(priceAnchor(cheaper, "zoho")?.ours.perSeatPerYear).toBe(2_000);
  });

  it("says nothing when the named vendor is not one we carry", () => {
    expect(priceAnchor(CATALOGUE, "somebody-else")).toBeNull();
    expect(priceAnchor(CATALOGUE, "")).toBeNull();
  });

  it("says nothing when there is nothing to compare against", () => {
    expect(priceAnchor([CATALOGUE[2]], "zoho")).toBeNull();
  });
});

describe("battlecardLines", () => {
  const lines = (message: string, hasCollateral = false) =>
    (battlecardLines({ message, catalogue: CATALOGUE, hasCollateral }) ?? []).join("\n");

  it("returns null when there is no objection to answer", () => {
    expect(battlecardLines({ message: "15 seats chahiye", catalogue: CATALOGUE })).toBeNull();
  });

  it("carries the price anchor for a named vendor", () => {
    const text = lines("Zoho cheaper hai");
    expect(text).toContain("Zoho Workplace Professional");
    expect(text).toContain("Google Workspace Business Starter");
    expect(text).toContain("Rs 3,360");
    expect(text).toContain("Rs 3,240");
  });

  it("omits the anchor when the customer named no vendor we carry", () => {
    const text = lines("cheaper mil raha hai kahin aur");
    expect(text).toContain("OBJECTION");
    expect(text).not.toContain("Price anchor");
  });

  it("NEVER offers a comparison sheet, because there is not one", () => {
    /* The brief's card ended "Kya main dono ka side-by-side feature comparison sheet
       bhejoon?". There is no such document anywhere in this app — checked. An agent offering
       one gets a yes and then goes quiet, which is worse than not offering. */
    for (const collateral of [false, true]) {
      const text = lines("Zoho cheaper hai", collateral);
      expect(text.toLowerCase()).not.toContain("comparison sheet");
    }
  });

  it("spells out the forbidden claims, not just the permitted ones", () => {
    /* The model's instinct is to reach for exactly these, so they are named rather than
       left to be inferred from silence. */
    const text = lines("Main direct Google se le lunga");
    expect(text).toContain("You must NOT state:");
    expect(text).toContain("does not issue a GST invoice");
  });
});
