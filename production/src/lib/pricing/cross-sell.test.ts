import { describe, it, expect } from "vitest";
import {
  authorisedOfferFigures,
  isOfferableName,
  offerCandidates,
  offerLines,
  unitFor,
} from "./cross-sell";
import { buildSalesAgentPrompt, perSeatPerYear, type SalesCatalogEntry } from "@/lib/ai/sales-agent";

/**
 * The live catalogue, as measured on 25 Aug 2026 — msrp/wholesale are ₹/seat/MONTH in `items`,
 * so they go through `perSeatPerYear` exactly as `loadSalesCatalog` does.
 */
const item = (name: string, vendor: string, msrp: number, wholesale: number): SalesCatalogEntry => ({
  sku: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  vendor,
  msrpPerSeatPerYear: perSeatPerYear(msrp),
  wholesalePerSeatPerYear: perSeatPerYear(wholesale),
  /* Null: these fixtures have no monthly-flex tier, which is what the live catalogue looked
     like for most rows. Cross-sell prices off the annual rate, so a monthly figure here would
     be an input the function under test never reads. */
  monthlyFlexPerSeatPerMonth: null,
});

const CATALOG: SalesCatalogEntry[] = [
  item("Google Workspace Business Starter", "google", 270, 110),
  item("Google Workspace Business Standard", "google", 864, 620),
  item("Google Workspace Business Plus", "google", 1380, 1150),
  item("Google Workspace Enterprise", "google", 2400, 2050),
  item("AppSheet Core", "google", 830, 720),
  item("Microsoft 365 Business Basic", "microsoft", 200, 165),
  item("Microsoft 365 Business Standard", "microsoft", 990, 820),
  item("Zoho Workplace Standard", "zoho", 120, 95),
  /* Real rows, and every one of them a trap. Bare tier names, kind='main'. */
  item("Standard", "hosting", 125, 0),
  item("Starter", "hosting", 50, 0),
  item("Plus", "hosting", 187, 0),
  item("Basic", "support", 250, 0),
  item("Premium", "support", 1667, 0),
  item("Free", "support", 0, 0),
  /* Named support tiers — real, per-account, and offerable. */
  item("ANUTECH DIGITAL PVT LTD Standard Support", "support", 999, 0),
  item("ANUTECH DIGITAL PVT LTD Enterprise Support", "support", 4999, 0),
  /* Real row, msrp 0 — the case the price filter is actually for. */
  item("ANUTECH DIGITAL PVT LTD Free Support", "support", 0, 0),
];

const STARTER = {
  name: "Google Workspace Business Starter",
  vendor: "google",
  pricePerSeatPerYear: perSeatPerYear(270),
};

const names = (c: ReturnType<typeof offerCandidates>) => c.map((x) => x.name);

/* ══ THE BRIEF'S OWN EXAMPLE CANNOT BE SAID ══════════════════════════════════ */

describe("the two products the brief wanted offered do not exist", () => {
  it("never offers anything that is not in the catalogue", () => {
    /* ─── MEASURED, NOT ASSUMED ───────────────────────────────────────────────
       The brief's example message offers "Email Archiving Backup (₹49/mo)" and "Professional
       Gmail Signature Setup". The live items table has 25 rows, all kind='main', and neither
       product is among them — nor is ₹49 the price of anything in it. The customer says yes,
       and then we either invent the product or take the offer back, and taking an offer back
       is worse than never making it. */
    const offered = names(offerCandidates(CATALOG, STARTER, { max: 10 }));
    expect(offered).not.toContain("Email Archiving Backup");
    expect(offered).not.toContain("Professional Gmail Signature Setup");
    for (const o of offered) {
      expect(CATALOG.map((c) => c.name)).toContain(o);
    }
  });

  it("never produces the price the brief invented", () => {
    /* ₹49/mo is ₹588/year. Nothing in the catalogue is either figure. Same failure as the ₹750
       in the telecalling brief, one step further along: there the price was wrong, here the
       product is. */
    const figures = authorisedOfferFigures(offerCandidates(CATALOG, STARTER, { max: 10 }));
    expect(figures).not.toContain(49);
    expect(figures).not.toContain(588);
    for (const f of figures) expect(f).toBeGreaterThan(0);
  });

  it("puts nothing in the prompt block that is not in the candidate list", () => {
    const candidates = offerCandidates(CATALOG, STARTER);
    const text = offerLines({ candidates, seats: 30 }).join("\n");
    expect(text).not.toMatch(/Archiving|Signature/i);
    expect(text).toContain("nothing else exists");
    expect(text).toContain("NEVER name a product that is not in the list above");
  });
});

/* ══ The bare-tier hazard ════════════════════════════════════════════════════ */

describe("a bare tier word cannot be offered, because resolveItem matches exactly", () => {
  it.each([
    ["Standard", "also a ₹125 hosting plan"],
    ["Starter", "also a ₹50 hosting plan"],
    ["Plus", "also a ₹187 hosting plan"],
    ["Basic", "also a ₹250 support tier"],
    ["Premium", "also a ₹1,667 support tier"],
    ["Free", "priced at zero"],
    ["Enterprise", "ambiguous across three vendors"],
  ])("refuses to offer %s (%s)", (name, why) => {
    /* THE LIVE HAZARD. `resolveItem` in quote-dispatcher.ts matches on EXACT NAME. Offer
       "Standard" to a Workspace customer, they accept, `leads.plan` becomes "Standard" — and
       the quote resolves to the ₹125 HOSTING product, not Workspace Standard at ₹864. A
       cross-sell that lands on the wrong SKU is worse than no cross-sell. */
    expect(isOfferableName(name), `should refuse: ${why}`).toBe(false);
    expect(names(offerCandidates(CATALOG, STARTER, { max: 20 }))).not.toContain(name);
  });

  it.each([
    "Google Workspace Business Standard",
    "AppSheet Core",
    "ANUTECH DIGITAL PVT LTD Standard Support",
    "Microsoft 365 Business Basic",
  ])("allows the unambiguous name %s", (name) => {
    expect(isOfferableName(name)).toBe(true);
  });

  it("treats an empty or whitespace name as unofferable", () => {
    expect(isOfferableName("")).toBe(false);
    expect(isOfferableName("   ")).toBe(false);
  });
});

/* ══ Units — the thirty-times error ══════════════════════════════════════════ */

describe("a candidate carries its unit, because the two differ by the seat count", () => {
  it.each([
    ["Google Workspace Business Standard", "google", "per_seat"],
    ["AppSheet Core", "google", "per_seat"],
    ["ANUTECH DIGITAL PVT LTD Standard Support", "support", "per_account"],
    ["Standard", "hosting", "per_account"],
    ["Custom Software Development", "other", "per_account"],
  ])("prices %s (%s) %s", (name, vendor, expected) => {
    /* loadSalesCatalog filters kind='main' precisely to keep add-ons out, and its comment gives
       the reason: they "are priced per-tenant-plan rather than per-seat and would be quoted as
       seats if they reached the prompt". ₹49 per seat per month over 30 seats is ₹17,640 a
       year; ₹49 per account is ₹588. One is wrong by thirty times and both look like a price. */
    expect(unitFor(item(name, vendor, 100, 50))).toBe(expected);
  });

  it("states the unit next to every figure in the prompt block", () => {
    const text = offerLines({ candidates: offerCandidates(CATALOG, STARTER), seats: 30 }).join("\n");
    for (const line of text.split("\n").filter((l) => /Rs /.test(l))) {
      expect(line, line).toMatch(/per seat per year|for the whole account per year/);
    }
  });

  it("tells the model not to multiply either kind itself", () => {
    const text = offerLines({ candidates: offerCandidates(CATALOG, STARTER), seats: 30 }).join("\n");
    expect(text).toContain("A per-seat figure multiplies by that; a");
    expect(text).toContain("Do not do either multiplication yourself");
    expect(text).toContain("the quotation does the arithmetic");
  });
});

/* ══ What is actually sellable ═══════════════════════════════════════════════ */

describe("offerCandidates", () => {
  it("offers the NEXT tier up, not the top one", () => {
    /* Three tiers up is a different budget, and leading with it reads as not having listened. */
    const c = offerCandidates(CATALOG, STARTER, { max: 1 });
    expect(c[0].kind).toBe("upgrade");
    expect(c[0].name).toBe("Google Workspace Business Standard");
    expect(c[0].pricePerUnitPerYear).toBe(perSeatPerYear(864));
    expect(c[0].stepUpPerUnitPerYear).toBe(perSeatPerYear(864) - perSeatPerYear(270));
  });

  it("pairs one upgrade with one attach rather than two upgrades", () => {
    /* They answer different questions, and a customer shown two upgrades is being pushed. */
    const c = offerCandidates(CATALOG, STARTER);
    expect(c.length).toBe(2);
    expect(c.map((x) => x.kind).sort()).toEqual(["attach", "upgrade"]);
  });

  it("never offers a competing vendor's plan", () => {
    /* Offering Microsoft 365 to somebody buying Google Workspace is not a cross-sell, it is
       restarting the conversation. */
    const offered = names(offerCandidates(CATALOG, STARTER, { max: 20 }));
    expect(offered.filter((n) => n.startsWith("Microsoft"))).toEqual([]);
    expect(offered.filter((n) => n.startsWith("Zoho"))).toEqual([]);
  });

  it("never volunteers a DOWNGRADE", () => {
    /* Doing the customer's negotiating for them. Offered from Business Plus, Starter and
       Standard are both cheaper and neither is an upgrade candidate. */
    const fromPlus = {
      name: "Google Workspace Business Plus",
      vendor: "google",
      pricePerSeatPerYear: perSeatPerYear(1380),
    };
    const upgrades = offerCandidates(CATALOG, fromPlus, { max: 20 }).filter((c) => c.kind === "upgrade");
    for (const u of upgrades) {
      expect(u.pricePerUnitPerYear).toBeGreaterThan(fromPlus.pricePerSeatPerYear);
    }
    expect(upgrades.map((u) => u.name)).toEqual(["Google Workspace Enterprise"]);
  });

  it("never offers the item they already have", () => {
    const offered = names(offerCandidates(CATALOG, STARTER, { max: 20 }));
    expect(offered).not.toContain("Google Workspace Business Starter");
  });

  it("never offers a zero-priced item", () => {
    /* "Free Support ₹0" is a real row. Offering it is offering nothing while sounding like an
       offer.

       ─── AND THE FIRST VERSION OF THIS TEST COULD NOT FAIL ────────────────────
       It asserted only on "Free", which is ALSO a bare tier word — so removing the price filter
       left it green, because isOfferableName was still excluding the row. Redundancy in the
       code, not weakness in the test, but a test that cannot distinguish the two guards is not
       testing either. The named row below has an unambiguous name and a zero price, so only the
       price filter can stop it. */
    expect(names(offerCandidates(CATALOG, STARTER, { max: 20 }))).not.toContain("Free");

    /* THE ROW THAT MAKES THE PRICE FILTER LOAD-BEARING, and it took two tries to find.
       A zero-priced item can never be an UPGRADE — 0 is not greater than any real price — and a
       same-vendor per-seat one is excluded by the family rule. So the only shape the price
       filter actually catches is a PER-ACCOUNT item at zero, with an unambiguous name. That row
       is real: "ANUTECH DIGITAL PVT LTD Free Support" is in the live catalogue at msrp 0, and
       without the filter it is offered as an attach. */
    expect(names(offerCandidates(CATALOG, STARTER, { max: 20 }))).not.toContain(
      "ANUTECH DIGITAL PVT LTD Free Support",
    );
  });

  it("never offers a below-cost item", () => {
    /* Same isBelowCost the main path uses. money-check.yml exists because four products once
       shipped priced under their own vendor cost, and an upsell that loses money is worse than
       no upsell. */
    const loss = item("Loss Leader Suite", "google", 100, 900);
    const offered = names(offerCandidates([...CATALOG, loss], STARTER, { max: 20 }));
    expect(offered).not.toContain("Loss Leader Suite");
  });

  it("finds AppSheet Core as a genuine same-vendor attach", () => {
    /* The one real add-on in this catalogue: a Google product that sits ALONGSIDE Workspace
       rather than replacing it, with a real wholesale cost. Offered from Business Plus, where
       it is cheaper than the plan and so reads as an add-on rather than a tier. */
    const fromPlus = {
      name: "Google Workspace Business Plus",
      vendor: "google",
      pricePerSeatPerYear: perSeatPerYear(1380),
    };
    const attaches = offerCandidates(CATALOG, fromPlus, { max: 20 }).filter((c) => c.kind === "attach");
    expect(attaches.map((a) => a.name)).toContain("AppSheet Core");
  });

  it("offers a named support tier as a per-account attach", () => {
    const attaches = offerCandidates(CATALOG, STARTER, { max: 20 }).filter((c) => c.kind === "attach");
    const support = attaches.find((a) => a.name.includes("Standard Support"));
    expect(support).toBeDefined();
    expect(support!.unit).toBe("per_account");
  });

  it("returns nothing when there is nothing to offer", () => {
    const only = [item("Google Workspace Enterprise", "google", 2400, 2050)];
    const fromTop = {
      name: "Google Workspace Enterprise",
      vendor: "google",
      pricePerSeatPerYear: perSeatPerYear(2400),
    };
    expect(offerCandidates(only, fromTop)).toEqual([]);
    expect(offerLines({ candidates: [], seats: 30 })).toEqual([]);
  });

  it("respects max, including zero", () => {
    expect(offerCandidates(CATALOG, STARTER, { max: 0 })).toEqual([]);
    expect(offerCandidates(CATALOG, STARTER, { max: 1 }).length).toBe(1);
    expect(offerCandidates(CATALOG, STARTER, { max: 5 }).length).toBeLessThanOrEqual(5);
  });

  it("holds a stable order between runs", () => {
    const a = names(offerCandidates(CATALOG, STARTER, { max: 5 }));
    const b = names(offerCandidates([...CATALOG].reverse(), STARTER, { max: 5 }));
    expect(a).toEqual(b);
  });
});

/* ══ An offer is a question ══════════════════════════════════════════════════ */

describe("offerLines", () => {
  const text = () => offerLines({ candidates: offerCandidates(CATALOG, STARTER), seats: 30 }).join("\n");

  it("tells the model to ASK, not to add", () => {
    /* The brief gets this right in its own example — "Kya main quotation mein yeh include kar
       du?" — and it is worth a rule rather than trusting the phrasing to hold. A quotation that
       silently gained a line is a document they find later, and the add-on is not what they
       will remember about it. */
    expect(text()).toContain("ASK.");
    expect(text()).toContain("never add it and never assume a yes");
  });

  it("puts the offer at the END, after the actual question is answered", () => {
    expect(text()).toContain("at the END, after you have answered what they actually asked");
    expect(text()).toContain("sold at, not helped");
  });

  it("refuses to offer something it cannot describe", () => {
    /* No benefit copy lives in this module, and inventing one is how "Email Archiving Backup"
       gets a feature list nobody wrote. */
    expect(text()).toContain("If you cannot say what it does without");
  });

  it("mentions the offer ONCE", () => {
    expect(text()).toContain("ONE mention");
  });

  it("omits the seat note when the seat count is unknown", () => {
    const t = offerLines({ candidates: offerCandidates(CATALOG, STARTER), seats: null }).join("\n");
    expect(t).not.toContain("They are asking about");
    /* But the unit instruction stays — it is about the figures, not the seat count. */
    expect(t).toContain("State the unit next to every figure");
  });
});

describe("authorisedOfferFigures", () => {
  it("carries exactly the figures the block states, and no zeroes", () => {
    /* The same discipline as authorisedTotalsFor and authorisedNetCostFigures: the allow-list
       and the prose come from ONE computation. Building them separately is how 24 Aug happened
       — the guard measured a draft against figures from a different source and approved one
       below our own cost. */
    const candidates = offerCandidates(CATALOG, STARTER);
    const figures = authorisedOfferFigures(candidates);
    const text = offerLines({ candidates, seats: 30 }).join("\n");

    for (const f of figures) {
      expect(text, `Rs ${f} is authorised but never stated`).toContain(f.toLocaleString("en-IN"));
    }
    expect(figures).not.toContain(0);
  });

  it("is empty when nothing is offered", () => {
    expect(authorisedOfferFigures([])).toEqual([]);
  });
});

/* ══ The invariant the first version broke ═══════════════════════════════════ */

describe("what KIND an item is does not depend on who is being offered it", () => {
  it("classifies AppSheet Core as an attach from every plan, not an upgrade from cheap ones", () => {
    /* ─── THE BUG A TEST CAUGHT, AND THE REASON THE RULE CHANGED ──────────────
       The first version defined an upgrade as "same vendor, per-seat, dearer than what they
       have". AppSheet Core is ₹830/seat/month — dearer than Business Starter (₹270) and cheaper
       than Business Plus (₹1,380) — so it came out an UPGRADE for a Starter customer and an
       ATTACH for a Plus customer. The same product, two kinds, decided by what the customer
       happened to be buying.

       It is not an upgrade in either case: AppSheet is app-building software, and telling a
       Starter customer to "upgrade" to it would offer them that instead of the mail they asked
       about. So the family comes from the NAME — a stable fact about the product — and never
       from the price, which is a fact about the comparison. */
    const plans = [
      { name: "Google Workspace Business Starter", vendor: "google", pricePerSeatPerYear: perSeatPerYear(270) },
      { name: "Google Workspace Business Standard", vendor: "google", pricePerSeatPerYear: perSeatPerYear(864) },
      { name: "Google Workspace Business Plus", vendor: "google", pricePerSeatPerYear: perSeatPerYear(1380) },
    ];

    for (const plan of plans) {
      const appsheet = offerCandidates(CATALOG, plan, { max: 20 }).find((c) => c.name === "AppSheet Core");
      expect(appsheet, `AppSheet Core should be offerable from ${plan.name}`).toBeDefined();
      expect(appsheet!.kind, `from ${plan.name}`).toBe("attach");
    }
  });

  it("classifies every Workspace tier as an upgrade of every cheaper Workspace tier", () => {
    const starter = {
      name: "Google Workspace Business Starter",
      vendor: "google",
      pricePerSeatPerYear: perSeatPerYear(270),
    };
    const upgrades = offerCandidates(CATALOG, starter, { max: 20 }).filter((c) => c.kind === "upgrade");
    expect(upgrades.map((u) => u.name)).toEqual([
      "Google Workspace Business Standard",
      "Google Workspace Business Plus",
      "Google Workspace Enterprise",
    ]);
  });

  it("never calls a per-account item an upgrade", () => {
    /* A support tier is not a bigger version of Workspace, whatever it costs. */
    const all = [
      ...offerCandidates(CATALOG, STARTER, { max: 20 }),
      ...offerCandidates(
        CATALOG,
        { name: "Google Workspace Enterprise", vendor: "google", pricePerSeatPerYear: perSeatPerYear(2400) },
        { max: 20 },
      ),
    ];
    for (const c of all.filter((x) => x.unit === "per_account")) {
      expect(c.kind, c.name).toBe("attach");
    }
  });
});

/* ══ Through the real prompt builder ════════════════════════════════════════ */

describe("the offer reaches the prompt, and its prices reach the money guard", () => {
  const build = (plan: string | null) =>
    buildSalesAgentPrompt({
      lead: {
        leadId: "L-1",
        company: "Sharma Traders",
        contactName: "Rahul",
        seats: 30,
        plan,
        customerContact: "rahul@sharmatraders.in",
        channel: "email",
        existingQuoteId: null, deliveredQuoteId: null,
        gstin: null,
      },
      history: [],
      incoming: "Please send the quotation.",
      catalog: CATALOG,
      sellerName: "ANUTECH DIGITAL",
      sellerEmail: "sales@anutech.in",
    });

  it("offers the next tier once we know what they are buying", () => {
    const p = build("Google Workspace Business Starter");
    expect(p.user).toContain("WHAT ELSE THEY COULD BE OFFERED");
    expect(p.user).toContain("UPGRADE to Google Workspace Business Standard");
  });

  it("says nothing when we do not know what they are buying yet", () => {
    /* "You could also add X" to somebody who has not chosen a product is a pitch before a
       conversation. */
    expect(build(null).user).not.toContain("WHAT ELSE THEY COULD BE OFFERED");
  });

  it("AUTHORISES the prices it just told the agent to state", () => {
    /* ─── WITHOUT THIS THE FEATURE WOULD BE DEAD ON ARRIVAL ───────────────────
       verifyDraftMoney measures every figure in a draft against allowedMoney. A block that
       states an upgrade price the guard has not been given would hand over every reply that
       mentioned one — exactly the "24/7"/"free" failure, in money: the prompt authorising a
       phrase its own guard then refuses. Both lists come from the SAME offerCandidates call. */
    const p = build("Google Workspace Business Starter");
    const standardYearly = perSeatPerYear(864);
    expect(p.user).toContain(standardYearly.toLocaleString("en-IN"));
    expect(p.allowedMoney).toContain(standardYearly);
    /* And the step-up figure, which the block also states. */
    expect(p.allowedMoney).toContain(standardYearly - perSeatPerYear(270));
  });

  it("does not widen the allow-list when nothing is offered", () => {
    const withPlan = build("Google Workspace Enterprise");
    const offered = offerCandidates(CATALOG, {
      name: "Google Workspace Enterprise",
      vendor: "google",
      pricePerSeatPerYear: perSeatPerYear(2400),
    });
    /* From the top tier there is no upgrade, only attaches — so any extra authorised figure
       must be one of theirs and nothing else. */
    for (const f of authorisedOfferFigures(offered)) {
      expect(withPlan.allowedMoney).toContain(f);
    }
  });
});

/* ══ A step-up must never authorise our own cost ═════════════════════════════ */

describe("authorisedOfferFigures excludes anything equal to a wholesale figure", () => {
  it("drops a step-up that lands exactly on our buying price", () => {
    /* ─── "UNLIKELY TO COLLIDE" IS NOT "CANNOT" ───────────────────────────────
       A step-up is one retail price minus another, and nothing about that arithmetic stops it
       coming out equal to a wholesale figure in the same catalogue. If it did,
       authorisedOfferFigures would hand verifyDraftMoney permission to approve a draft stating
       what we PAY — and wholesale never entering allowedMoney is one of the oldest rules in this
       family (see BuiltPrompt.allowedMoney).

       Constructed so the collision is exact: retail 100 and 700 per month, so the step up is
       600 × 12 = 7,200 per year — and the dearer item's own cost is also 600 × 12. */
    const cheap = item("Acme Mail Basic Plan", "acme", 100, 50);
    const dear = item("Acme Mail Pro Plan", "acme", 700, 600);
    const catalog = [cheap, dear];
    const current = {
      name: cheap.name,
      vendor: "acme",
      pricePerSeatPerYear: cheap.msrpPerSeatPerYear,
    };

    const candidates = offerCandidates(catalog, current, { max: 5 });
    const stepUp = candidates.find((c) => c.kind === "upgrade")!.stepUpPerUnitPerYear;
    expect(stepUp).toBe(dear.wholesalePerSeatPerYear);

    /* Without the catalogue it would be authorised — which is the hole. */
    expect(authorisedOfferFigures(candidates)).toContain(stepUp);
    /* With it, the cost figure is gone and the two real prices remain. */
    const safe = authorisedOfferFigures(candidates, catalog);
    expect(safe).not.toContain(stepUp);
    expect(safe).toContain(dear.msrpPerSeatPerYear);
  });

  it("never authorises any wholesale figure from the catalogue", () => {
    const candidates = offerCandidates(CATALOG, STARTER, { max: 20 });
    const authorised = authorisedOfferFigures(candidates, CATALOG);
    for (const c of CATALOG) {
      if (c.wholesalePerSeatPerYear > 0) {
        expect(authorised, `cost ${c.wholesalePerSeatPerYear} (${c.name})`).not.toContain(
          c.wholesalePerSeatPerYear,
        );
      }
    }
  });

  it("still authorises the retail prices it stated", () => {
    const candidates = offerCandidates(CATALOG, STARTER, { max: 20 });
    const authorised = authorisedOfferFigures(candidates, CATALOG);
    for (const c of candidates) {
      expect(authorised).toContain(c.pricePerUnitPerYear);
    }
  });
});
