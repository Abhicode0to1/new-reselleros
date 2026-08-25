import { describe, it, expect } from "vitest";
import {
  PITCH_VARIANTS,
  VARIANT_CLAIM_UNIVERSE,
  armFor,
  decidePromotion,
  pitchVariant,
  requiredSamplePerArm,
  variantLines,
  type VariantId,
} from "./ab-test";
import { findPromises } from "./promise-check";
import { findDisparagement } from "./disparagement";

/* ══ THE NUMBER THAT DECIDES THE WHOLE FEATURE ═══════════════════════════════ */

describe("how much evidence a 25% lift actually needs", () => {
  it("needs about eleven hundred quotes PER ARM on a 20% base rate", () => {
    /* ─── AND THIS TENANT HAS ISSUED TWENTY QUOTES, EVER ──────────────────────
       Measured 25 Aug 2026: 20 quotes total (17 accepted, 1 sent, 2 draft), 0 agent messages
       ever written, 0 AI actions with outcome `sent`. The brief asks the system to notice a 25%
       lift and make the winner the default for every future customer.

       Standard two-proportion sample size, 95% confidence and 80% power. Computed rather than
       asserted so the answer moves with the assumptions. */
    const n = requiredSamplePerArm(0.2, 0.25);
    expect(n).toBeGreaterThan(1_000);
    expect(n).toBeLessThan(1_200);
  });

  it("needs MORE evidence for a smaller lift, and less for a bigger one", () => {
    expect(requiredSamplePerArm(0.2, 0.1)).toBeGreaterThan(requiredSamplePerArm(0.2, 0.25));
    expect(requiredSamplePerArm(0.2, 0.5)).toBeLessThan(requiredSamplePerArm(0.2, 0.25));
  });

  it("returns Infinity for a lift of zero or less", () => {
    /* Asking how many samples prove no difference is asking the wrong question, and returning a
       finite number would let a caller display one. */
    expect(requiredSamplePerArm(0.2, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(requiredSamplePerArm(0.2, -0.1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not divide by zero or blow up at the edges of the rate", () => {
    for (const base of [0, 0.0001, 0.5, 0.99, 1]) {
      const n = requiredSamplePerArm(base, 0.25);
      expect(Number.isNaN(n)).toBe(false);
      expect(n).toBeGreaterThan(0);
    }
  });
});

/* ══ It never promotes, and that is the feature ══════════════════════════════ */

describe("decidePromotion never switches the default script", () => {
  it("refuses even when one arm is dramatically ahead", () => {
    /* ─── AUTO-PROMOTION IS THE FAILURE MODE, NOT THE FEATURE ─────────────────
       8 accepted of 10 against 6 of 10 is not a finding, it is two extra customers who would
       have said yes anyway. The brief pairs that with "future ke saare customers ke liye default
       bana dega", which turns a coin toss into a permanent change to what this company says to
       everybody — with the test switched off afterwards because a winner was declared.

       A wrong answer nobody revisits is worse than no answer, and worse for a specific reason:
       it arrives wearing the authority of data, so the next person to doubt it has to argue
       with a number rather than with a guess. */
    const d = decidePromotion({
      arms: [
        { variant: "conversational", sent: 10, accepted: 8 },
        { variant: "formal", sent: 10, accepted: 3 },
      ],
      baseRate: 0.2,
      relativeLift: 0.25,
    });
    expect(d.promote).toBe(false);
    expect(d.leading).toBe("conversational");
    expect(d.reason).toContain("far too few to mean anything");
    expect(d.reason).toContain("lock in a coin toss");
    expect(d.reason).toContain("nothing changes automatically");
  });

  it("says which arm is ahead, because that is worth knowing even when it proves nothing", () => {
    const d = decidePromotion({
      arms: [
        { variant: "formal", sent: 4, accepted: 3 },
        { variant: "conversational", sent: 4, accepted: 1 },
      ],
      baseRate: 0.2,
      relativeLift: 0.25,
    });
    expect(d.leading).toBe("formal");
    expect(d.smallestArm).toBe(4);
    expect(d.reason).toContain("Formal and technical is ahead");
  });

  it("reports level when the rates are equal rather than picking one", () => {
    const d = decidePromotion({
      arms: [
        { variant: "formal", sent: 6, accepted: 2 },
        { variant: "conversational", sent: 6, accepted: 2 },
      ],
      baseRate: 0.2,
      relativeLift: 0.25,
    });
    expect(d.leading).toBeNull();
    expect(d.reason).toContain("level so far");
  });

  it("says nothing can be compared when one arm has sent nothing", () => {
    /* Today's actual state: zero AI messages have ever reached a customer. */
    const d = decidePromotion({
      arms: [
        { variant: "formal", sent: 0, accepted: 0 },
        { variant: "conversational", sent: 0, accepted: 0 },
      ],
      baseRate: 0.2,
      relativeLift: 0.25,
    });
    expect(d.smallestArm).toBe(0);
    expect(d.leading).toBeNull();
    expect(d.reason).toContain("Nothing has been sent under at least one");
    expect(d.reason).toContain("Keep both running");
  });

  it("survives an empty arm list", () => {
    const d = decidePromotion({ arms: [], baseRate: 0.2, relativeLift: 0.25 });
    expect(d.promote).toBe(false);
    expect(d.smallestArm).toBe(0);
  });

  it("puts the required sample size in the sentence a person reads", () => {
    /* This is what makes the feature useful TODAY, which auto-promotion would not be: it says
       "you need about 1,100 per arm, you have 4" instead of silently picking one. */
    const d = decidePromotion({
      arms: [
        { variant: "formal", sent: 4, accepted: 3 },
        { variant: "conversational", sent: 4, accepted: 1 },
      ],
      baseRate: 0.2,
      relativeLift: 0.25,
    });
    expect(d.reason).toMatch(/1,0\d\d|1,1\d\d/);
    expect(d.reason).toContain("in EACH arm");
  });
});

/* ══ A variant changes how, never what ══════════════════════════════════════ */

describe("a variant reorders authorised claims and adds nothing", () => {
  it("only ever leads with claims from the authorised universe", () => {
    /* The third module to hold this line, after tone.ts and trade-in.ts — and it matters most
       here. An experiment that could introduce claims would be an experiment in what the company
       is willing to assert, run automatically, on strangers. */
    for (const v of PITCH_VARIANTS) {
      for (const claim of v.leadWith) {
        expect(VARIANT_CLAIM_UNIVERSE, `${v.id} leads with an unauthorised claim`).toContain(claim);
      }
    }
  });

  it("points at the authorised list rather than restating it", () => {
    for (const v of PITCH_VARIANTS) {
      const text = variantLines(v.id).join("\n");
      expect(text).toContain("Of the things you MAY promise above");
      expect(text).toContain("It adds nothing to that list");
      expect(text).toContain("at most two still applies");
    }
  });

  it("puts no figure in any variant's own instructions", () => {
    /* A number here would be a claim the experiment introduced. The prohibitions are excluded
       because they are deliberately written in the words they forbid. */
    for (const v of PITCH_VARIANTS) {
      const own = v.register.join(" ");
      expect(own).not.toMatch(/₹|Rs\s*\d|\d+\s*%/);
      expect(own.match(/(?<![\w.])\d{3,}(?![\w])/g)).toBeNull();
    }
  });

  it("produces register lines that would themselves survive both draft guards", () => {
    /* Anything in a prompt can be echoed into a reply. */
    for (const v of PITCH_VARIANTS) {
      const own = v.register.join(" ");
      expect(findPromises(own).safe, `${v.id}: ${findPromises(own).reason}`).toBe(true);
      expect(findDisparagement(own).clean).toBe(true);
    }
  });

  it("gives every variant something it must not say", () => {
    /* A variant with a register and no prohibitions is a variant that only loosens. */
    for (const v of PITCH_VARIANTS) {
      expect(v.refuse.length, `${v.id} forbids nothing`).toBeGreaterThan(0);
    }
  });

  it("throws on an unknown variant rather than returning undefined", () => {
    // @ts-expect-error deliberately outside the union
    expect(() => pitchVariant("aggressive")).toThrow(/unknown pitch variant/);
  });
});

/* ══ The three selling points that cannot be said ════════════════════════════ */

describe("what the brief wanted in each variant and cannot have", () => {
  const formal = variantLines("formal").join("\n");
  const conversational = variantLines("conversational").join("\n");

  it("refuses the 99.9% SLA, by name and on merits", () => {
    /* SALES_AGENT_SYSTEM_PROMPT forbids uptime figures explicitly. And it is not ours to offer:
       we resell somebody else's platform and underwrite nothing about its availability. */
    expect(formal).toContain("Do NOT state an uptime figure or an SLA percentage");
    expect(formal).toContain("underwrite nothing about its availability");
    expect(formal).toContain("read that number back to us");
  });

  it("refuses the ISO certification", () => {
    /* Same class as the Google Partner certificate refused in tone.ts — a checkable credential,
       and TASKS.md records that even the reseller agreement is not approved. */
    expect(formal).toContain("Do NOT claim an ISO certification");
    expect(formal).toContain("a serious technical buyer checks it first");
  });

  it("refuses the 2-hour migration, which the guard also now catches", () => {
    expect(conversational).toContain("Do NOT put a duration on the migration");
    expect(conversational).toContain("not two hours");
    /* Closure: the phrase the brief wanted is refused on the draft path too, as of the duration
       fixes made earlier today. */
    expect(findPromises("Free 2 hour migration included.").safe).toBe(false);
    expect(findPromises("2 ghante mein migrate kar denge.").safe).toBe(false);
  });

  it("refuses a forex percentage, and keeps the rupee-billing fact in the variant that leads with it", () => {
    /* Two different variants, and the first version of this test looked for both in one. The
       conversational arm leads with migration and support; INR billing is the FORMAL arm's
       claim. The prohibition on a percentage belongs with the arm most likely to reach for one,
       which is the benefit-led pitch. */
    expect(conversational).toContain("Do NOT state a card, forex or bank percentage");
    expect(conversational).toContain("what their bank charges is a fact about their contract");
    expect(formal).toContain("being billed in rupees by an Indian company");
  });

  it("refuses to name WhatsApp as a staffed support channel", () => {
    /* Round-the-clock support from a local team is authorised. Naming a specific channel is a
       commitment about which desk is open, which is not the agent's to make. */
    expect(conversational).toContain("naming WhatsApp specifically is a commitment");
  });

  it("keeps the three points that ARE authorised", () => {
    /* The brief's better variant is built from things we can actually say — that is the point. */
    expect(formal).toContain("the GST tax invoice and the input tax credit it carries");
    expect(conversational).toContain("migration of their existing mail being included");
    expect(conversational).toContain("round-the-clock support from a local team");
  });
});

/* ══ Assignment ═════════════════════════════════════════════════════════════ */

describe("armFor", () => {
  it("gives one lead the same arm every time", () => {
    /* ─── WHY NOT Math.random() ────────────────────────────────────────────────
       A customer who gets the formal pitch in the morning and the conversational one in the
       evening is being contradicted by the same company in the same thread — the exact failure
       the unified memory built earlier today exists to prevent. A random draw per message
       guarantees it. */
    const id = "L-8f3a-2291";
    const first = armFor(id);
    for (let i = 0; i < 50; i += 1) expect(armFor(id)).toBe(first);
  });

  it("splits a realistic set of ids reasonably evenly", () => {
    /* Not exactly 50/50 — it is a hash, not a shuffle — but a split worse than 35/65 would mean
       one arm never fills and the test could never conclude even in principle. */
    const ids = Array.from({ length: 400 }, (_, i) => `LEAD-${i}-${(i * 7919) % 1000}`);
    const formal = ids.filter((id) => armFor(id) === "formal").length;
    expect(formal / ids.length).toBeGreaterThan(0.35);
    expect(formal / ids.length).toBeLessThan(0.65);
  });

  it("produces both arms and nothing else", () => {
    const seen = new Set<VariantId>(
      Array.from({ length: 200 }, (_, i) => armFor(`lead-${i}`)),
    );
    expect([...seen].sort()).toEqual(["conversational", "formal"]);
  });

  it("is stable for ids that differ only at the end", () => {
    /* FNV-1a mixes every byte, so near-identical ids do not all land in one arm — which a naive
       "last character is even" rule would do to sequential ids. */
    const near = Array.from({ length: 20 }, (_, i) => `L-000000${i}`);
    const arms = new Set(near.map(armFor));
    expect(arms.size).toBe(2);
  });

  it("handles an empty id without throwing", () => {
    expect(["formal", "conversational"]).toContain(armFor(""));
  });
});
