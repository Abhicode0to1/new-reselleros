import { describe, it, expect } from "vitest";
import {
  AUTHORISED_CLAIMS,
  TONE_PROFILES,
  detectTone,
  toneLines,
  toneProfile,
  type Tone,
} from "./tone";
import { SALES_AGENT_SYSTEM_PROMPT, buildSalesAgentPrompt } from "./sales-agent";
import { findPromises } from "./promise-check";

const linesFor = (message: string) => toneLines(detectTone(message)).join("\n");

/* ══ THE INVARIANT ═══════════════════════════════════════════════════════════
   Everything else in this file is detail. This is the reason the module is safe to exist. */

describe("tone reorders authorised claims — it NEVER adds one", () => {
  it("every tone's leadWith is a subset of AUTHORISED_CLAIMS", () => {
    /* A tone module that could attach a new claim would be the most dangerous file in this
       repo, because it would attach it exactly where it is most likely to be believed and
       least likely to be checked: a credential to the customer who said they are unsure, a
       speed promise to the customer who said they are in a hurry. */
    for (const t of TONE_PROFILES) {
      for (const claim of t.leadWith) {
        expect(AUTHORISED_CLAIMS, `${t.id} leads with an unauthorised claim`).toContain(claim);
      }
    }
  });

  it("never restates a claim, only points at the list that holds it", () => {
    /* The four sentences live in SALES_AGENT_SYSTEM_PROMPT and stay there. A second copy of a
       claim rule stops matching the first — the same reason prices are read at call time
       rather than written into this module. So the rendered block refers the model UP to that
       list rather than repeating any of it. */
    for (const t of TONE_PROFILES) {
      const rendered = toneLines({ tone: t.id, cues: ["x"], alsoSaw: [] }).join("\n");
      if (t.leadWith.length > 0) {
        expect(rendered).toContain("Of the things you MAY promise above");
        expect(rendered).toContain("It does not add anything to that list");
      }
    }
  });

  it("puts no rupee figure, percentage or long number in any tone block", () => {
    /* Numbers are what this repo's money discipline is about, and a tone block is the last
       place one should appear: it is rendered from cues in a customer's message, so a figure
       here would be a price the customer's own wording selected. The percentages that DO
       appear in the refusals are quoted as things NOT to say, and are checked below. */
    for (const t of TONE_PROFILES) {
      const rendered = toneLines({ tone: t.id, cues: ["x"], alsoSaw: [] }).join("\n");
      const withoutProhibitions = rendered
        .split("\n")
        .filter((l) => !/\bDo NOT\b|\bnot\b.*\bcharge\b|issuers charge/.test(l))
        .join("\n");
      expect(withoutProhibitions).not.toMatch(/₹|Rs\s*\d|\d+\s*%/);
      expect(withoutProhibitions.match(/(?<![\w.:])\d{3,}(?![\w])/g)).toBeNull();
    }
  });

  it("produces a block that would itself survive the promise guard", () => {
    /* Anything in a prompt can end up echoed in a reply. A register instruction containing a
       token findPromises refuses would hold every mail it was attached to — which is exactly
       what happened to "24/7" and "free" before maskAuthorisedSellingPoints existed. The
       refusals are excluded because they are deliberately made of forbidden words. */
    for (const t of TONE_PROFILES) {
      const profile = toneProfile(t.id);
      const instructions = [...profile.register].join(" ");
      if (!instructions.trim()) continue;
      const verdict = findPromises(instructions);
      expect(verdict.safe, `${t.id} register would be refused: ${verdict.reason}`).toBe(true);
    }
  });
});

/* ══ The three refusals the brief asked for ══════════════════════════════════ */

describe("what the brief asked for and cannot be said", () => {
  it("refuses the Google Partner certificate to the hesitant customer", () => {
    /* TASKS.md:1564 records the Google reseller agreement as NOT approved and "not obtainable
       by a developer". We do not hold the certificate. And this is aimed at the one customer
       who will check — the partner directories are public, and a skeptic who looks us up and
       does not find us has been given a reason to disbelieve the rest of the mail. */
    const text = linesFor("Pehle kabhi Anutech se nahi liya, kaise pata chalega genuine ho?");
    expect(text).toContain("Do NOT claim to be an official, certified or authorised Google");
    expect(text).toContain("partner certificate");
    expect(text).toContain("TASKS.md:1564");
  });

  it("refuses client logos, because no consent for them exists anywhere", () => {
    const text = linesFor("Koi reference de sakte ho? Bharosa nahi ho raha.");
    expect(text).toContain("Do NOT name another customer");
    expect(text).toContain("client logos");
    expect(text).toContain("their disclosure to make, not ours");
  });

  it("refuses the 10-minute setup to the urgent customer", () => {
    /* provisioning.activate is off on the dial and decideProvisioning refuses on test keys, so
       a ten-minute activation cannot happen today even if the claim were true. */
    const text = linesFor("Aaj hi email chalu chahiye, urgent hai");
    expect(text).toContain("Do NOT state how long anything will take");
    expect(text).toContain("Not ten minutes");
    expect(text).toContain("automatic activation");
  });

  it("refuses an SLA figure next to the support claim", () => {
    /* Round-the-clock support is authorised. A number beside it is a contract, and it slipped
       the promise guard for a specific reason recorded in tone.ts's header. */
    const text = linesFor("Support kaisa hai? Pehle kabhi liya nahi hai aapse");
    expect(text).toContain("no response time");
    expect(text).toContain("a figure next to it is a contract");
  });

  it("refuses monthly billing as the CHEAPER option to a price-sensitive customer", () => {
    /* The subtle one. Monthly is a real tier here — but commitment-rate.ts records that a real
       monthly-flex tier normally costs MORE per month than a twelfth of the annual rate. So
       offering it as relief to somebody who just said the price is high sells them the dearer
       option while it sounds like a concession. */
    const text = linesFor("Bohot mehenga hai ye");
    expect(text).toContain("Do NOT offer monthly billing as the cheaper option");
    expect(text).toContain("DEARER per month");
    expect(text).toContain("commitment-rate.ts");
  });

  it("refuses a card or forex percentage to the customer most likely to be told one", () => {
    const text = linesFor("Price bahut zyada hai, budget nahi hai");
    expect(text).toContain("Do NOT state a card, forex or bank percentage");
    /* Asserted within one line. The first version looked for "issuers charge a range", which
       spans a line break in the source array — a substring test against joined lines has to
       respect where the joins are. */
    expect(text).toContain("You do not know their bank");
    expect(text).toContain("charge a range rather than one number");
  });

  it("refuses a discount as an answer to the objection", () => {
    const text = linesFor("Rate kam karo, mehenga hai");
    expect(text).toContain("Do NOT offer a discount to close the objection");
    expect(text).toContain("not by argument");
  });
});

/* ══ The contradiction this feature found in the prompt itself ═══════════════ */

describe("the authorised claim list no longer contradicts the net-cost block", () => {
  it("does not put a card percentage in WHAT YOU MAY PROMISE", () => {
    /* THE BUG THIS PINS. The list used to authorise "no 3.5% foreign-currency card loading"
       while the net-cost block in the SAME prompt said "do NOT state what a card or bank
       charges". Both were present on every message with a product and a seat count, and which
       one won was up to the model. net-cost.ts:21 is why the second is right: issuers charge
       roughly 1.75% to 3.5%, so naming one number is false precision about a contract between
       the customer and their own bank. */
    const list = SALES_AGENT_SYSTEM_PROMPT.slice(
      SALES_AGENT_SYSTEM_PROMPT.indexOf("WHAT YOU MAY PROMISE"),
      SALES_AGENT_SYSTEM_PROMPT.indexOf("Use AT MOST TWO"),
    );
    /* ─── AND THIS ASSERTION WAS TOO BLUNT AT FIRST ──────────────────────────
       "no percentage anywhere in the list" fails on "claims 100% input tax credit", which is a
       legitimate claim about a statutory entitlement rather than false precision about
       somebody else's bank. 100% ITC is what GST law grants on a valid tax invoice; 3.5% was a
       guess about a contract we cannot see. The invariant is about the second kind only, so it
       is asserted about the second kind only. */
    expect(list).not.toMatch(/3\.5\s*%/);
    expect(list).not.toMatch(/%[^\n]*\b(?:card|forex|foreign|bank)\b/i);
    expect(list).not.toMatch(/\b(?:card|forex|foreign|bank)\b[^\n]*%/i);
    expect(list).toContain("Billing in rupees, by an Indian company");
    /* The one percentage that stays, named so a later reader knows it was considered. */
    expect(list).toContain("100% input tax credit");
  });

  it("still authorises all four claims", () => {
    /* The fix removed a figure, not a selling point. */
    const list = SALES_AGENT_SYSTEM_PROMPT.slice(
      SALES_AGENT_SYSTEM_PROMPT.indexOf("WHAT YOU MAY PROMISE"),
      SALES_AGENT_SYSTEM_PROMPT.indexOf("Use AT MOST TWO"),
    );
    expect(list.split("\n").filter((l) => l.trim().startsWith("- ")).length).toBe(4);
  });
});

/* ══ Detection ══════════════════════════════════════════════════════════════ */

describe("detectTone", () => {
  it.each([
    ["Bohot mehenga hai", "price_sensitive"],
    ["This is too expensive for our budget", "price_sensitive"],
    ["Rate kam karo bhai", "price_sensitive"],
    ["Pehle kabhi Anutech se nahi liya", "hesitant"],
    ["How do I know you are genuine?", "hesitant"],
    ["Bharosa nahi ho raha", "hesitant"],
    ["Aaj hi email chalu chahiye", "urgent"],
    ["Need this ASAP please", "urgent"],
    ["Jaldi karo, urgent hai", "urgent"],
  ])("reads %s as %s", (message, expected) => {
    expect(detectTone(message).tone).toBe(expected);
  });

  it("reads an ordinary enquiry as neutral and changes nothing", () => {
    /* The important half. Most messages are not any of these three, and for those the prompt
       must come out exactly as it did before this module existed. */
    const reading = detectTone("Hello, we need Google Workspace for 30 users. Annual please.");
    expect(reading.tone).toBe("neutral");
    expect(toneLines(reading)).toEqual([]);
  });

  it("matches whole words only", () => {
    /* The same trap battlecards.ts documents: substring matching turns an innocent word into
       an objection. "costume" is not "costly"; "fasten" is not "fast". */
    expect(detectTone("We sell costumes online").tone).toBe("neutral");
    expect(detectTone("Please fasten the attachment").tone).toBe("neutral");
    expect(detectTone("Our budgeting software integrates").tone).toBe("neutral");
  });

  it("survives punctuation, casing and repeated whitespace", () => {
    expect(detectTone("BOHOT MEHENGA HAI!!!").tone).toBe("price_sensitive");
    expect(detectTone("...urgent!!!  aaj   hi  chahiye").tone).toBe("urgent");
  });

  it("reports the words that decided it", () => {
    /* Checkable after the fact, which is the whole reason detection reads the customer's text
       instead of the model's sentiment field. "it said 'mehenga'" can be verified; "the model
       felt they were price sensitive" cannot. */
    const reading = detectTone("Bohot mehenga hai, budget nahi hai");
    expect(reading.cues).toContain("mehenga");
    expect(reading.cues).toContain("budget");
    expect(linesFor("Bohot mehenga hai, budget nahi hai")).toContain("from their own words");
  });

  it("breaks a tie toward the tone that says LESS", () => {
    /* One cue each. Urgent wins because its instruction set is the most restrictive — it
       forbids every timing claim — and a tie should land on the tone that promises least. */
    const reading = detectTone("mehenga hai aur urgent bhi hai");
    expect(reading.tone).toBe("urgent");
    expect(reading.alsoSaw).toContain("price_sensitive");
  });

  it("lets a clear majority of cues win over the tie order", () => {
    const reading = detectTone("bohot mehenga hai, budget nahi hai, rate kam karo — urgent");
    expect(reading.tone).toBe("price_sensitive");
    expect(reading.alsoSaw).toContain("urgent");
  });
});

/* ══ Cumulative prohibitions ═════════════════════════════════════════════════ */

describe("prohibitions are cumulative across every tone that fired", () => {
  it("keeps the urgent refusals when price cues outnumber urgency cues", () => {
    /* THE CASE THIS EXISTS FOR. "Bohot mehenga hai, budget bhi kam hai, rate kam karo, aur
       aaj hi chahiye" is led by the price objection — and must still not get a speed promise
       merely because the price cues were more numerous. Only the ordering and the register
       come from the winner; what is forbidden is the union. Widening a prohibition is always
       the safe direction, the same asymmetry lib/ai/pipeline.ts relies on. */
    const text = linesFor("Bohot mehenga hai, budget kam hai, rate kam karo, aur aaj hi chahiye");
    expect(text).toContain("They sound price sensitive");
    expect(text).toContain("Do NOT state how long anything will take");
    expect(text).toContain("Do NOT offer monthly billing as the cheaper option");
  });

  it("keeps the partner-certificate refusal when a skeptic is also in a hurry", () => {
    const text = linesFor("Pehle kabhi nahi liya, par aaj hi chahiye urgent");
    expect(text).toContain("Do NOT claim to be an official");
    expect(text).toContain("Do NOT state how long anything will take");
  });

  it("does not repeat the winner's own refusals twice", () => {
    const text = linesFor("mehenga hai aur urgent bhi");
    const occurrences = text.split("Do NOT state how long anything will take").length - 1;
    expect(occurrences).toBe(1);
  });
});

/* ══ Rendering ══════════════════════════════════════════════════════════════ */

describe("toneLines", () => {
  it("puts the register before the lead-with ordering", () => {
    const text = linesFor("Bohot mehenga hai");
    expect(text.indexOf("Answer the number")).toBeLessThan(text.indexOf("lead with"));
  });

  it("reminds the model the two-claim limit still applies", () => {
    /* Reordering a list is not permission to recite it. The prompt's own rule — at most two,
       because four in every mail is what makes a person sound like a brochure — is repeated
       here because this block is what is being read at the moment the choice is made. */
    expect(linesFor("Bohot mehenga hai")).toContain("the limit of at most two still applies");
  });

  it("gives the urgent customer a shape, not a speed", () => {
    const text = linesFor("Urgent hai, jaldi chahiye");
    expect(text).toContain("The next step goes in the FIRST line");
    expect(text).toContain("Urgency is answered by being easy to act on");
  });

  it("throws on an unknown tone rather than rendering nothing", () => {
    // @ts-expect-error deliberately outside the union
    expect(() => toneProfile("angry")).toThrow(/unknown tone/);
  });

  it("has a stated refusal set for every tone that can fire", () => {
    /* A tone with cues but no refusals is a tone that only ever loosens how we write, which is
       the one shape this module must not have. */
    for (const t of TONE_PROFILES) {
      if (t.cues.length === 0) continue;
      expect(t.refuse.length, `${t.id} has cues but forbids nothing`).toBeGreaterThan(0);
    }
  });

  it("names every tone in the union", () => {
    const ids = TONE_PROFILES.map((t) => t.id).sort();
    const expected: Tone[] = ["hesitant", "neutral", "price_sensitive", "urgent"];
    expect(ids).toEqual(expected.sort());
  });
});

/* ══ The wiring, through the real prompt builder ═════════════════════════════ */

describe("the tone block reaches the responder's prompt", () => {
  const catalog = [
    {
      sku: "s",
      name: "Google Workspace Business Starter",
      vendor: "google",
      msrpPerSeatPerYear: 3240,
      wholesalePerSeatPerYear: 1320,
      monthlyFlexPerSeatPerMonth: null,
    },
  ];
  const lead = {
    leadId: "L-1",
    company: "Sharma Traders",
    contactName: "Rahul",
    seats: 30,
    plan: "Google Workspace Business Starter",
    customerContact: "rahul@sharmatraders.in",
    channel: "email" as const,
    existingQuoteId: null,
    gstin: null,
  };
  const build = (incoming: string) =>
    buildSalesAgentPrompt({
      lead,
      history: [],
      incoming,
      catalog,
      sellerName: "ANUTECH DIGITAL",
      sellerEmail: "sales@anutech.in",
    }).user;

  it("carries the refusals for a real price objection", () => {
    const user = build("Bohot mehenga hai, itna budget nahi hai");
    expect(user).toContain("HOW THIS CUSTOMER IS WRITING");
    expect(user).toContain("Do NOT offer monthly billing as the cheaper option");
  });

  it("puts HOW to answer before WHAT is available to answer with", () => {
    /* A register instruction read after the catalogue is an instruction applied to prose the
       model has already planned. The tone block goes above the price list for that reason. */
    const user = build("Aaj hi chalu chahiye, urgent hai");
    expect(user.indexOf("HOW THIS CUSTOMER IS WRITING")).toBeLessThan(user.indexOf("CATALOGUE"));
  });

  it("leaves an ordinary enquiry's prompt untouched", () => {
    /* The measurement that matters most. Most messages carry none of these cues, and for those
       the prompt must be exactly what it was before this module existed. */
    const user = build("Hello, we need Workspace for 30 users on annual billing. Please quote.");
    expect(user).not.toContain("HOW THIS CUSTOMER IS WRITING");
  });

  it("does not add a money figure to the prompt's allow-list", () => {
    /* The invariant, checked at the only place it could actually do harm. `allowedMoney` is
       what verifyDraftMoney measures a draft against, so a tone that widened it would let a
       figure through by way of the customer's wording. */
    const plain = buildSalesAgentPrompt({
      lead, history: [], incoming: "Please quote for 30 users, annual.",
      catalog, sellerName: "ANUTECH DIGITAL", sellerEmail: "sales@anutech.in",
    });
    const toned = buildSalesAgentPrompt({
      lead, history: [], incoming: "Bohot mehenga hai, aaj hi chahiye, pehle kabhi nahi liya",
      catalog, sellerName: "ANUTECH DIGITAL", sellerEmail: "sales@anutech.in",
    });
    expect([...toned.allowedMoney].sort()).toEqual([...plain.allowedMoney].sort());
  });
});
