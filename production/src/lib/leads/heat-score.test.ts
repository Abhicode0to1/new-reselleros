import { describe, it, expect } from "vitest";
import {
  heatScore, heatBand, heatBadge, classifyDomain, emailDomainOf, sourceQuality,
  WEIGHT, HOT_FROM, WARM_FROM, UNKNOWN_SOURCE_QUALITY,
} from "./heat-score";
import type { Lead } from "@/lib/supabase/database.types";

const NOW = new Date("2026-08-14T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: "L1", company: "Acme", contact_email: null, contact_phone: null,
  domain: null, seats: null, source: null, stage: "new", value: null,
  priority: "medium", is_junk: false,
  created_at: daysAgo(0), updated_at: daysAgo(0),
  ...over,
} as unknown as Lead);

describe("emailDomainOf", () => {
  it("takes the part after the LAST @", () => {
    expect(emailDomainOf("a.b+tag@tatamotors.com")).toBe("tatamotors.com");
    expect(emailDomainOf("weird@@gmail.com")).toBe("gmail.com");
  });

  it("returns null for anything that is not an address", () => {
    for (const v of [null, undefined, "", "no-at-sign", "trailing@", "@leading", "user@localhost"]) {
      expect(emailDomainOf(v as string | null)).toBeNull();
    }
  });
});

describe("classifyDomain — the @tatamotors.com vs @gmail.com question", () => {
  it("scores a company domain as corporate", () => {
    expect(classifyDomain(lead({ contact_email: "ravi@tatamotors.com" })))
      .toEqual({ klass: "corporate", domain: "tatamotors.com" });
  });

  it("scores a free provider as consumer, not as junk", () => {
    // Plenty of real Indian SMEs run on Gmail. Consumer is a weaker signal, not a
    // disqualification — hence 0.35 of the weight rather than 0.
    expect(classifyDomain(lead({ contact_email: "ravi@gmail.com" })).klass).toBe("consumer");
    expect(classifyDomain(lead({ contact_email: "x@rediffmail.com" })).klass).toBe("consumer");
  });

  it("scores a throwaway address as disposable — zero", () => {
    expect(classifyDomain(lead({ contact_email: "x@mailinator.com" })).klass).toBe("disposable");
  });

  it("prefers the recorded company domain over a personal contact address", () => {
    /* A rep often records the company's real domain while the enquiry arrives from a
       personal address. Scoring the Gmail would punish the rep for capturing MORE. */
    const l = lead({ domain: "tatamotors.com", contact_email: "ravi.personal@gmail.com" });
    expect(classifyDomain(l)).toEqual({ klass: "corporate", domain: "tatamotors.com" });
  });

  it("tolerates a domain recorded as a URL", () => {
    expect(classifyDomain(lead({ domain: "https://tatamotors.com/contact" })).domain)
      .toBe("tatamotors.com");
  });

  it("is unknown with nothing to go on", () => {
    expect(classifyDomain(lead())).toEqual({ klass: "unknown", domain: null });
  });
});

describe("sourceQuality", () => {
  it("ranks a referral above a purchased list", () => {
    expect(sourceQuality("referral")).toBeGreaterThan(sourceQuality("purchased"));
    expect(sourceQuality("trial")).toBeGreaterThan(sourceQuality("csv"));
  });

  it("normalises spacing, case and separators", () => {
    for (const v of ["cold-call", "Cold Call", "COLD_CALL", "  cold call  "]) {
      expect(sourceQuality(v)).toBe(0.25);
    }
  });

  it("scores an UNMAPPED source neutrally, never zero", () => {
    /* An unrecognised label is our gap in the mapping. Scoring it zero would quietly
       bury every lead from a channel nobody has added yet. */
    expect(sourceQuality("some-new-channel")).toBe(UNKNOWN_SOURCE_QUALITY);
    expect(sourceQuality(null)).toBe(UNKNOWN_SOURCE_QUALITY);
  });
});

describe("heatScore — the whole number", () => {
  it("the weights sum to 100, so the score is a percentage of something real", () => {
    const total = WEIGHT.domain + WEIGHT.seats + WEIGHT.source + WEIGHT.stage + WEIGHT.freshness;
    expect(total).toBe(100);
  });

  it("the parts always add up to the score shown", () => {
    // A tooltip listing components that do not sum to the badge is worse than no
    // tooltip. Each part is rounded once; the total is their sum.
    const r = heatScore(lead({
      contact_email: "ravi@tatamotors.com", seats: 37, source: "website", stage: "demo",
    }), null, NOW);
    const sum = r.parts.domain + r.parts.seats + r.parts.source + r.parts.stage + r.parts.freshness;
    expect(sum).toBe(r.score);
  });

  it("a perfect lead scores 100", () => {
    const r = heatScore(lead({
      contact_email: "cio@tatamotors.com", seats: 250, source: "referral", stage: "quote",
      updated_at: daysAgo(0),
    }), null, NOW);
    expect(r.score).toBe(100);
    expect(r.band).toBe("hot");
    expect(r.incomplete).toBe(false);
  });

  it("a throwaway address with nothing behind it scores near zero", () => {
    const r = heatScore(lead({
      contact_email: "x@mailinator.com", seats: null, source: "purchased", stage: "new",
      updated_at: daysAgo(30),
    }), null, NOW);
    // domain 0 + seats 0 + source 2 + stage 2 + freshness 0
    expect(r.score).toBeLessThan(10);
    expect(r.band).toBe("cold");
  });

  it("separates two leads that differ ONLY by domain, by the full domain weight", () => {
    const base = { seats: 50, source: "website", stage: "contact" as const, updated_at: daysAgo(1) };
    const corp = heatScore(lead({ ...base, contact_email: "ravi@tatamotors.com" }), null, NOW);
    const cons = heatScore(lead({ ...base, contact_email: "ravi@gmail.com" }), null, NOW);
    expect(corp.parts.domain - cons.parts.domain).toBe(30 - Math.round(30 * 0.35));
    expect(corp.score).toBeGreaterThan(cons.score);
  });

  it("gives more to 250 seats than to 3", () => {
    const base = { contact_email: "a@acme.in", source: "website", stage: "contact" as const };
    const big   = heatScore(lead({ ...base, seats: 250 }), null, NOW);
    const small = heatScore(lead({ ...base, seats: 3 }), null, NOW);
    expect(big.parts.seats).toBe(25);
    // 3 seats falls in the 1+ band (0.25), not the 5+ band — 25 x 0.25 = 6.
    expect(small.parts.seats).toBe(6);
  });
});

describe("heatScore — what it refuses to pretend it knows", () => {
  it("marks the score INCOMPLETE when the seat count is missing", () => {
    /* A 45 that means "we never asked how many seats" must not read the same as a 45
       we measured. The badge says so. */
    const r = heatScore(lead({ contact_email: "a@tatamotors.com", source: "referral", seats: null }), null, NOW);
    expect(r.incomplete).toBe(true);
    expect(r.reasons.some((x) => /No seat count/i.test(x))).toBe(true);
  });

  it("marks it incomplete when there is no domain OR email", () => {
    expect(heatScore(lead({ seats: 20, source: "referral" }), null, NOW).incomplete).toBe(true);
  });

  it("is complete once both are known", () => {
    const r = heatScore(lead({ contact_email: "a@acme.in", seats: 20, source: "referral" }), null, NOW);
    expect(r.incomplete).toBe(false);
  });

  it("gives a BRAND-NEW lead full freshness rather than punishing it", () => {
    // A lead imported five minutes ago has no activity history. Starting freshness at
    // zero would score the newest leads hardest.
    const noStamps = { ...lead({ seats: 10, contact_email: "a@acme.in" }), updated_at: null, created_at: null } as unknown as Lead;
    expect(heatScore(noStamps, null, NOW).parts.freshness).toBe(WEIGHT.freshness);
  });

  it("names an unmapped source in the reasons instead of hiding the guess", () => {
    const r = heatScore(lead({ source: "trade-fair-2026", seats: 5, contact_email: "a@acme.in" }), null, NOW);
    expect(r.reasons.some((x) => /unmapped/i.test(x))).toBe(true);
  });
});

describe("heatScore — freshness decay", () => {
  const base = { contact_email: "a@tatamotors.com", seats: 100, source: "referral", stage: "quote" as const };

  it.each([
    [0,  10],
    [2,  10],
    [8,   5],
    [14,  0],
    [40,  0],
  ])("%s days quiet → %s freshness points", (days, expected) => {
    const r = heatScore(lead({ ...base, updated_at: daysAgo(days) }), null, NOW);
    expect(r.parts.freshness).toBe(expected);
  });

  it("a GOOD lead going quiet is the combination worth surfacing", () => {
    /* This is why the score is not a re-derivation of intentTier: a great lead can be
       cooling. Score stays high on who they are; freshness is what drops. */
    const quiet = heatScore(lead({ ...base, updated_at: daysAgo(20) }), null, NOW);
    expect(quiet.parts.domain).toBe(30);
    expect(quiet.parts.freshness).toBe(0);
    expect(quiet.score).toBe(90);            // still hot on merit
    expect(quiet.reasons.some((x) => /Quiet for 20 days/.test(x))).toBe(true);
  });

  it("never goes negative on a future timestamp (clock skew)", () => {
    const future = lead({ ...base, updated_at: new Date(NOW.getTime() + 86_400_000).toISOString() });
    expect(heatScore(future, null, NOW).parts.freshness).toBe(10);
  });
});

describe("heatBand + heatBadge — the 🔥 / ☀️ / ❄️ thresholds", () => {
  it("uses the brief's exact boundaries", () => {
    expect(heatBand(100)).toBe("hot");
    expect(heatBand(HOT_FROM)).toBe("hot");
    expect(heatBand(HOT_FROM - 1)).toBe("warm");
    expect(heatBand(WARM_FROM)).toBe("warm");
    expect(heatBand(WARM_FROM - 1)).toBe("cold");
    expect(heatBand(0)).toBe("cold");
  });

  it("renders one presentation per band, so every surface agrees", () => {
    expect(heatBadge("hot")).toEqual({ emoji: "🔥", label: "Hot",  kind: "danger" });
    expect(heatBadge("warm")).toEqual({ emoji: "☀️", label: "Warm", kind: "warning" });
    expect(heatBadge("cold")).toEqual({ emoji: "❄️", label: "Cold", kind: "info" });
  });
});

describe("heatScore — worked examples a seller would recognise", () => {
  it("Tata Motors, 200 seats, referral, quote sent → 🔥", () => {
    const r = heatScore(lead({
      company: "Tata Motors", contact_email: "it@tatamotors.com", seats: 200,
      source: "referral", stage: "quote", updated_at: daysAgo(1),
    }), null, NOW);
    expect(r.score).toBe(100);
    expect(heatBadge(r.band).emoji).toBe("🔥");
  });

  it("a Gmail enquiry for 5 seats off a CSV import → ❄️", () => {
    const r = heatScore(lead({
      contact_email: "sunil1987@gmail.com", seats: 5, source: "csv", stage: "new",
      updated_at: daysAgo(5),
    }), null, NOW);
    // domain 11 + seats 10 + source 7 + stage 2 + freshness 8
    expect(r.score).toBe(38);
    expect(heatBadge(r.band).emoji).toBe("❄️");
  });

  it("a mid-size enquiry on Gmail, trial running → ☀️", () => {
    /* No recorded company domain — so the Gmail is all we have to go on. A first
       version of this example ALSO set domain: "brightsystems.in", which makes it 88
       and hot: the recorded domain wins over the personal address, exactly as the
       classifyDomain test asserts. The example contradicted the rule it sat next to,
       not the code. */
    const r = heatScore(lead({
      contact_email: "owner@gmail.com", seats: 30,
      source: "buy-page", stage: "trial", updated_at: daysAgo(2),
    }), null, NOW);
    expect(r.score).toBe(69);
    expect(r.band).toBe("warm");
    expect(r.score).toBeGreaterThanOrEqual(WARM_FROM);
    expect(r.score).toBeLessThan(HOT_FROM);
  });
});
