import { describe, it, expect } from "vitest";
import { buildAiActionRecord } from "./action-log";

const base = {
  tenantId: "fbb976f1-9090-4f10-9726-0901bd144e42",
  action: "quote.send" as const,
  outcome: "did" as const,
  reason: "  the customer stated the term  ",
  mode: "auto" as const,
};

describe("buildAiActionRecord — the shape", () => {
  it("keeps the reason, trimmed", () => {
    expect(buildAiActionRecord(base).reason).toBe("the customer stated the term");
  });

  it("records the mode in force, so a later config change stays explicable", () => {
    /* Without this, a row from last week reads as inexplicable the moment somebody moves a
       dial: "why did it send?" has no answer in the data. */
    expect(buildAiActionRecord({ ...base, mode: "hold" }).mode).toBe("hold");
  });

  it("defaults entity and entityId to null rather than omitting them", () => {
    const r = buildAiActionRecord(base);
    expect(r.entity).toBeNull();
    expect(r.entityId).toBeNull();
  });
});

describe("the facts are evidence, not a request dump", () => {
  it("keeps flat scalars", () => {
    const r = buildAiActionRecord({
      ...base,
      facts: { seats: 50, product: "Google Workspace Business Starter", termStated: true, discount: null },
    });
    expect(r.facts).toEqual({
      seats: 50,
      product: "Google Workspace Business Starter",
      termStated: true,
      discount: null,
    });
  });

  it("refuses nested objects and counts them instead", () => {
    /* A nested shape here is the beginning of a request dump — unbounded, unread, and
       quietly holding whatever happened to be in scope. Counting them tells the author to
       flatten rather than letting it grow. */
    const r = buildAiActionRecord({
      ...base,
      facts: { seats: 50, lead: { id: "L-1", company: "X" }, lines: [1, 2, 3] },
    });
    expect(r.facts.seats).toBe(50);
    expect(r.facts.lead).toBeUndefined();
    expect(r.facts._droppedComplexFacts).toBe(2);
  });

  it("does not count anything when every fact is flat", () => {
    expect(buildAiActionRecord({ ...base, facts: { seats: 1 } }).facts._droppedComplexFacts)
      .toBeUndefined();
  });

  it("truncates a long value instead of dropping it", () => {
    /* Usually a subject line or the sentence the extractor matched — the first 200
       characters are what identifies it. */
    const long = "x".repeat(500);
    const r = buildAiActionRecord({ ...base, facts: { subject: long } });
    expect(String(r.facts.subject)).toHaveLength(201);
    expect(String(r.facts.subject).endsWith("…")).toBe(true);
  });
});

describe("customer message bodies never reach the log", () => {
  it.each(["body", "text", "html", "message", "body_text", "raw_html"])(
    "redacts %s by key name",
    (key) => {
      /* A customer's email body is not evidence about a decision — the extracted facts are
         — and copying it here puts the same private text in a second table with a different
         retention story. Redaction is by KEY, so a careless call site gets a marker rather
         than the log becoming where customer mail accumulates. */
      const r = buildAiActionRecord({ ...base, facts: { [key]: "Dear sir, my GSTIN is 07ABDCA0298H1ZP" } });
      expect(r.facts[key]).toBe("[redacted]");
    },
  );

  it.each(["token", "secret", "api_key", "password"])("redacts %s", (key) => {
    const r = buildAiActionRecord({ ...base, facts: { [key]: "sk-live-abc123" } });
    expect(r.facts[key]).toBe("[redacted]");
  });

  it("does not redact an innocent key that merely contains a banned word", () => {
    /* "somebody" ends in "body" and is not a message body. Suffix-on-underscore, not
       substring — over-redaction hides evidence just as effectively as under-redaction
       leaks it. */
    const r = buildAiActionRecord({ ...base, facts: { somebody: "yes", keyword: "annual" } });
    expect(r.facts.somebody).toBe("yes");
    expect(r.facts.keyword).toBe("annual");
  });
});

describe("held is a first-class outcome", () => {
  it("records a hold with its reason, not as a failure", () => {
    /* The rows worth reading over breakfast: each is a real customer waiting on a decision
       only a person can make. A log that recorded only sends would make a careful system —
       13 AI routes that draft and none that send — look idle. */
    const r = buildAiActionRecord({
      ...base,
      outcome: "held",
      reason: "the mail did not say monthly or annual, so the price is an assumption",
      facts: { termStated: false, seats: 50 },
    });
    expect(r.outcome).toBe("held");
    expect(r.facts.termStated).toBe(false);
  });

  it("keeps skipped and failed apart", () => {
    /* Skipped was a choice; failed was not. Merging them would make a working kill switch
       look like an outage. */
    expect(buildAiActionRecord({ ...base, outcome: "skipped" }).outcome).toBe("skipped");
    expect(buildAiActionRecord({ ...base, outcome: "failed" }).outcome).toBe("failed");
  });
});
