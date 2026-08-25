import { describe, it, expect } from "vitest";
import {
  TRADE_IN_FORBIDDEN,
  TRADE_IN_CLAIM_UNIVERSE,
  switchProfile,
  tradeInFacts,
} from "./trade-in";
import { findDisparagement } from "./disparagement";
import { PROVIDER_BRANDS, identifyProvider, type MxRecord } from "@/lib/dns/domain-inspect";
import { applyHandoverRules, buildSalesAgentPrompt, type SalesAgentDecision } from "./sales-agent";
import { findPromises } from "./promise-check";

const mx = (...hosts: string[]): MxRecord[] =>
  hosts.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));

const profileFor = (...hosts: string[]) => switchProfile(identifyProvider(mx(...hosts)));
const factsFor = (...hosts: string[]) => tradeInFacts(profileFor(...hosts)).join("\n");

/* ══ The invariant, again ════════════════════════════════════════════════════ */

describe("the trade-in reorders authorised claims — it never adds one", () => {
  it("only ever leads with a claim from the authorised universe", () => {
    /* Same property lib/ai/tone.ts holds, asserted separately because this module reaches the
       same list by a different route: the MX record rather than the customer's wording. */
    const cases = [
      profileFor("smtp.secureserver.net"),
      profileFor("mx.rediffmailpro.com"),
      profileFor("aspmx.l.google.com"),
      profileFor("mx1.hostinger.in"),
      profileFor(),
    ];
    for (const p of cases) {
      for (const claim of p.leadWith) {
        expect(TRADE_IN_CLAIM_UNIVERSE).toContain(claim);
      }
    }
  });

  it("puts no rupee figure or percentage in the block", () => {
    /* A trade-in block containing a number would be a discount selected by somebody's MX
       record, which is the strangest possible way to price a deal. */
    const text = factsFor("smtp.secureserver.net");
    expect(text).not.toMatch(/₹|Rs\s*\d|\d+\s*%/);
  });
});

/* ══ The four claims the brief asked for ═════════════════════════════════════ */

describe("what the brief asked for and cannot be offered", () => {
  const all = TRADE_IN_FORBIDDEN.join(" | ");

  it("refuses a free month, and says what the real mechanism is", () => {
    /* lib/pricing/workspace.ts:13 — "NO hardcoded tier promos. Discounts go through the coupon
       / site-promo system (redeem_coupon / create_site_promo), not baked into pricing." So the
       answer is not "no", it is "that is a COUPON": a real thing this platform can do, with a
       code, an expiry and a record of who redeemed it. A sentence in an email has none of
       those, and the quotation will not honour it — the customer gets a promise in prose and an
       invoice that disagrees. */
    expect(all).toContain("Do NOT offer a free month");
    expect(all).toContain("COUPONS with a code and an expiry");
    expect(all).toContain("the quotation will not");
  });

  it("refuses to touch their DNS", () => {
    expect(all).toContain("Do NOT offer to set up, configure, change, harden");
    expect(all).toContain("behind their registrar login");
  });

  it("refuses the SPF/DKIM/DMARC lockdown by name", () => {
    /* The dangerous one, and not for compliance reasons — every failure mode is silent mail
       loss on a live business's domain. DMARC at p=reject makes legitimate mail vanish rather
       than bounce; SPF permits ten DNS lookups and crossing that line breaks authentication
       for EVERYTHING the domain sends, not just the new sender. */
    expect(all).toContain("configure SPF, DKIM or DMARC");
  });

  it("refuses to call their current provider worse than ours", () => {
    expect(all).toContain("Do NOT say or imply that their current provider is old");
    expect(all).toContain("one MX record and nothing else");
  });

  it("refuses client logos here too, not only in the tone module", () => {
    /* Both paths can reach a hesitant switcher, and a prohibition that exists on only one of
       them is a prohibition with a door in it. */
    expect(all).toContain("Do NOT name another customer");
  });

  it("carries every prohibition into the rendered block", () => {
    const text = factsFor("smtp.secureserver.net");
    for (const f of TRADE_IN_FORBIDDEN) {
      expect(text).toContain(f);
    }
  });
});

/* ══ Reading the switch situation ════════════════════════════════════════════ */

describe("switchProfile", () => {
  it.each([
    ["smtp.secureserver.net", "GoDaddy"],
    ["mx.rediffmailpro.com", "Rediffmail Pro"],
    ["mx1.hostinger.in", "Hostinger"],
    ["mx.bigrock.in", "BigRock"],
  ])("treats %s (%s) as a switch", (host, from) => {
    const p = profileFor(host);
    expect(p.isSwitcher).toBe(true);
    expect(p.from).toBe(from);
    expect(p.leadWith[0]).toBe("migration_included");
  });

  it.each([
    ["aspmx.l.google.com", "Google Workspace"],
    ["sharma-in.mail.protection.outlook.com", "Microsoft 365"],
    ["mx.zoho.com", "Zoho Mail"],
  ])("treats %s (%s) as a change of SUPPLIER, not a migration", (host, from) => {
    /* An important distinction the brief did not draw. If their mail already runs on a platform
       we sell, there is nothing to move — offering to migrate it is offering to do nothing, and
       it reads exactly like that. */
    const p = profileFor(host);
    expect(p.isSwitcher).toBe(false);
    expect(p.samePlatform).toBe(true);
    expect(p.from).toBe(from);
    expect(p.leadWith).not.toContain("migration_included");
  });

  it("says nothing when the records are unrecognised", () => {
    /* We do not know what they are on, so "we will move you off it" is a sentence about a
       system we cannot see — the same reason identifyProvider refuses to guess a provider. */
    const p = profileFor("mail.someverysmallhost.co.in");
    expect(p.isSwitcher).toBe(false);
    expect(p.from).toBeNull();
    expect(tradeInFacts(p)).toEqual([]);
  });

  it("says nothing when there is no MX at all", () => {
    const p = profileFor();
    expect(p.isSwitcher).toBe(false);
    expect(tradeInFacts(p)).toEqual([]);
  });

  it("does not call a filtering layer a switch", () => {
    /* Mimecast in front of an unknown mailbox host means the mailbox host is unknown. Reading
       the filter as their provider would produce "we will migrate you off Mimecast", which is
       not a mail migration at all. */
    const p = profileFor("in-a.mimecast.com");
    expect(p.isSwitcher).toBe(false);
    expect(p.from).toBeNull();
  });

  it("still reads through a filter to a platform we sell", () => {
    const p = profileFor("in-a.mimecast.com", "sharma-in.mail.protection.outlook.com");
    expect(p.samePlatform).toBe(true);
    expect(p.from).toBe("Microsoft 365");
  });
});

describe("tradeInFacts", () => {
  it("names the provider and leads with migration", () => {
    const text = factsFor("smtp.secureserver.net");
    expect(text).toContain("Their mail is currently handled by GoDaddy");
    expect(text).toContain("lead with");
    expect(text).toContain("migration of their existing mail and data being included");
  });

  it("says the trade-in is ALREADY on the authorised list", () => {
    /* The finding this module rests on. The brief wanted a new incentive invented; the
       incentive it reached for was already authorised and simply never led with. */
    expect(factsFor("smtp.secureserver.net")).toContain("ALREADY ON YOUR LIST");
  });

  it("tells the model not to offer a migration to somebody who needs none", () => {
    const text = factsFor("aspmx.l.google.com");
    /* Asserted within one line. The reword that removed "today" also moved this line break —
       a substring test against joined lines has to respect where the joins fall. */
    expect(text).toContain("this is a change of supplier and");
    expect(text).toContain("NOT a migration — there is nothing to move");
    expect(text).toContain("offering");
  });

  it("keeps the two-claim limit visible", () => {
    expect(factsFor("mx1.hostinger.in")).toContain("the limit of at most two");
  });

  it("would itself survive both guards — and TWO WORDS DID NOT, at first", () => {
    /* ─── THIS TEST FOUND A REAL BUG IN THIS MODULE ───────────────────────────
       Anything in a prompt can be echoed into a reply, so a block's own statements have to be
       sendable. The first version of this one said "Their mail runs on GoDaddy TODAY" and "of
       the things you MAY PROMISE" — both tokens findPromises refuses, both kinds in
       RELEVANT_PROMISE_KINDS, so a model repeating either phrase would have had its reply held.

       For "today" that was near-certain rather than possible: the sentence is almost exactly
       what inspectionFacts tells the agent to state, so it is the phrasing most likely to come
       back out. Every switcher's reply would have handed over — a feature alive and dead at the
       same time, which is what maskAuthorisedSellingPoints was written about.

       The prohibitions are excluded because they are deliberately made of forbidden words. */
    const statements = tradeInFacts(profileFor("smtp.secureserver.net"))
      .filter((l) => !l.trim().startsWith("- Do NOT") && !l.includes("WHAT YOU MAY NOT OFFER"))
      .join("\n");
    expect(findDisparagement(statements).clean).toBe(true);
    expect(findPromises(statements).safe).toBe(true);
  });
});

/* ══ The guard that was missing ══════════════════════════════════════════════ */

describe("findDisparagement — the hole measured 25 Aug 2026", () => {
  it.each([
    ["Your legacy GoDaddy setup is outdated.", "the brief's own framing"],
    ["Rediffmail is obsolete now.", "a named provider"],
    ["Your current provider is insecure.", "no brand, same claim"],
    ["Hostinger ka mail purana hai.", "Hinglish"],
    ["GoDaddy ka setup ghatiya hai.", "Hinglish, stronger"],
    ["Webmail is unreliable, switch to Workspace.", "the category name"],
    ["Your existing setup is no longer supported.", "a multi-word pejorative"],
  ])("catches %s (%s)", (line, why) => {
    /* THE MEASUREMENT. Every one of these came back SAFE from the whole draft path before this
       guard existed: none is a promise, none names a figure, none commits to a date, so
       findPromises had nothing to say and the sentence went out. MIGRATION_CLAIMS_FORBIDDEN had
       forbidden it in the prompt since the day before — and a prompt instruction is not a
       guard. */
    expect(findPromises(line).safe, `${why}: promise check sees nothing, by design`).toBe(true);
    expect(findDisparagement(line).clean, `should catch: ${why}`).toBe(false);
  });

  it.each([
    ["sharmatraders.in's mail is currently handled by GoDaddy.", "yesterday's whole feature"],
    ["Free migration of existing mail and data.", "an authorised claim"],
    ["Your old mailboxes will be migrated across.", "operational, not an insult"],
    ["Microsoft 365 Business Basic is another option.", "'Basic' is a product name"],
    ["Zoho Workplace is cheaper on its entry plan.", "the customer's own objection, answered"],
    ["Sharma Traders Private Limited, we will bill you in rupees.", "'Limited' is in the name"],
    [
      "Your mail is currently handled by GoDaddy. Our own platform is not outdated.",
      "two innocent sentences a whole-text check would join",
    ],
  ])("still lets %s through (%s)", (line, why) => {
    /* DELIBERATELY NARROW. A guard that refuses the company's own authorised phrases kills the
       feature it protects — that already happened here once, when findPromises refused "24/7"
       and "free" and every reply using the real selling points handed over. The last case is
       why the check is sentence-scoped: the first of those two sentences is exactly what
       inspectionFacts is built to produce. */
    expect(findDisparagement(line).clean, `should allow: ${why}`).toBe(true);
  });

  it("names the words and the subject in the reason", () => {
    /* §24: the fix is almost always to delete one adjective and send the rest, so the operator
       needs to see which adjective. */
    const r = findDisparagement("Your legacy GoDaddy setup is outdated.");
    expect(r.clean).toBe(false);
    expect(r.reason).toContain("GoDaddy");
    expect(r.reason).toContain("Remove the judgement");
    expect(r.findings[0].sentence).toContain("GoDaddy");
  });

  it("draws its brand list from the MX signature table, not a second copy", () => {
    /* Two lists of competitor names do not stay equal: add a signature and a hand-written
       guard list goes on being blind to the brand the app now recognises. */
    expect(PROVIDER_BRANDS).toContain("GoDaddy");
    expect(PROVIDER_BRANDS).toContain("Rediffmail");
    expect(PROVIDER_BRANDS).toContain("Hostinger");
    expect(PROVIDER_BRANDS.length).toBeGreaterThan(10);
    /* Parentheticals stripped, so a sentence saying "Mimecast" matches. */
    expect(PROVIDER_BRANDS).toContain("Mimecast");
    expect(PROVIDER_BRANDS.some((b) => b.includes("("))).toBe(false);
  });
});

/* ══ Wired into the chain that actually stops a reply ════════════════════════ */

describe("the disparagement guard holds the draft", () => {
  const decisionWith = (body: string): SalesAgentDecision => ({
    customer_intent: "wants to move from GoDaddy",
    perceived_sentiment: "neutral",
    confidence_score: 0.95,
    action_required: "REPLY",
    generated_response: { email_subject: "Re: email", body_text: body, whatsapp_summary: "hi" },
    next_followup_loop: null,
    seats_discussed: 30,
  });

  it("hands over a draft that runs down the old provider", () => {
    const r = applyHandoverRules({
      decision: decisionWith("Hello. Your legacy GoDaddy setup is outdated. We can help."),
      seats: 30,
      allowedMoney: [],
    });
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.overruled).toBe(true);
    expect(r.reason).toContain("GoDaddy");
  });

  it("lets the honest observation through", () => {
    /* The sentence yesterday's feature exists to produce. If this handed over, the domain
       lookup would be unusable. */
    const r = applyHandoverRules({
      decision: decisionWith(
        "Hello. sharmatraders.in's mail is currently handled by GoDaddy. Migration of your existing mail is included. Send me the seat count and I will prepare the quotation.",
      ),
      seats: 30,
      allowedMoney: [],
    });
    expect(r.decision.action_required).toBe("REPLY");
    expect(r.overruled).toBe(false);
  });
});

/* ══ Through the real prompt builder ════════════════════════════════════════ */

describe("the trade-in block reaches the prompt", () => {
  const build = (tradeIn?: readonly string[]) =>
    buildSalesAgentPrompt({
      lead: {
        leadId: "L-1",
        company: "Sharma Traders",
        contactName: "Rahul",
        seats: 30,
        plan: "Google Workspace Business Starter",
        customerContact: "rahul@sharmatraders.in",
        channel: "email",
        existingQuoteId: null,
        gstin: null,
      },
      history: [],
      incoming: "We want to move our email over. Currently with GoDaddy.",
      catalog: [
        {
          sku: "s",
          name: "Google Workspace Business Starter",
          vendor: "google",
          msrpPerSeatPerYear: 3240,
          wholesalePerSeatPerYear: 1320,
        },
      ],
      sellerName: "ANUTECH DIGITAL",
      sellerEmail: "sales@anutech.in",
      tradeInFacts: tradeIn,
    });

  it("carries the prohibitions when the lead is a switcher", () => {
    const user = build(tradeInFacts(profileFor("smtp.secureserver.net"))).user;
    expect(user).toContain("THIS IS A SWITCH");
    expect(user).toContain("Do NOT offer a free month");
    expect(user).toContain("configure SPF, DKIM or DMARC");
  });

  it("leaves the prompt untouched when there is no switch to describe", () => {
    expect(build(undefined).user).not.toContain("THIS IS A SWITCH");
    expect(build([]).user).not.toContain("THIS IS A SWITCH");
  });

  it("does not widen the money allow-list", () => {
    /* The only place a widened claim could reach a customer's invoice. */
    const plain = build(undefined);
    const switcher = build(tradeInFacts(profileFor("smtp.secureserver.net")));
    expect([...switcher.allowedMoney].sort()).toEqual([...plain.allowedMoney].sort());
  });
});
