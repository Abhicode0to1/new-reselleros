import { describe, it, expect } from "vitest";
import {
  A_PLUS_SEATS,
  businessDomainFromEmail,
  gradeLead,
  gradeSummary,
  isFreeMailbox,
  type LeadFactsForGrading,
} from "./grading";
import { REVIEW_ABOVE_SEATS } from "@/lib/pricing/volume-slabs";
import { findPromises } from "@/lib/ai/promise-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** ANUTECH's own GSTIN — real and checksum-valid (CLAUDE.md §1). */
const REAL_GSTIN = "07ABDCA0298H1ZP";

const facts = (over: Partial<LeadFactsForGrading> = {}): LeadFactsForGrading => ({
  gstin: REAL_GSTIN,
  contactEmail: "rahul@sharmatraders.in",
  seatsWritten: 30,
  term: "annual",
  clarity: "specific",
  hasPhone: true,
  ...over,
});

/* ══ THE CORRECTION: a free mailbox is not a bad lead ════════════════════════ */

describe("a company on Gmail is the customer who has NOT bought what we sell", () => {
  it("does not deduct anything for a free mailbox", () => {
    /* ─── THE COMMERCIAL POINT, AND IT REVERSES HALF THE BRIEF ────────────────
       We sell business email. Somebody writing from sharmatraders@gmail.com has not bought it —
       the need is entirely unmet, there is no incumbent, no migration, and nobody else's
       contract in the way. Somebody writing from rahul@sharmatraders.in already HAS business
       email from a competitor, and winning them means a switch.

       CLAUDE.md §1 says who this platform is for: Indian resellers selling to SMEs. The SME
       running off a free mailbox is the textbook first-Workspace purchase. Grading them D and
       dropping them in a nurture loop deprioritises the easiest sale in the pipeline. */
    const onGmail = gradeLead(facts({ contactEmail: "sharmatraders@gmail.com" }));
    const onOwnDomain = gradeLead(facts({ contactEmail: "rahul@sharmatraders.in" }));

    /* The domain scores a little — a company that bought a domain is usually a bigger deal —
       but the gap is small, and the gmail lead is nowhere near D. */
    expect(onGmail.score).toBeGreaterThanOrEqual(onOwnDomain.score - 10);
    expect(onGmail.grade).toBe("A+");
  });

  it("says out loud why a free mailbox is an opportunity", () => {
    const g = gradeLead(facts({ contactEmail: "sharmatraders@gmail.com" }));
    expect(g.reasons.join(" ")).toContain("no business email yet");
    expect(g.reasons.join(" ")).toContain("no incumbent to displace");
  });

  it("grades a VAGUE enquiry down, whatever address it came from", () => {
    /* The half of the brief's Grade D that IS a real signal. "Single personal Gmail ID, vague
       inquiry" bundled two independent things; the vagueness is the one that matters, and it
       matters just as much from a company domain. */
    const vagueGmail = gradeLead(
      facts({ contactEmail: "someone@gmail.com", clarity: "vague", gstin: null, seatsWritten: null, term: null }),
    );
    const vagueCorporate = gradeLead(
      facts({ contactEmail: "someone@bigco.in", clarity: "vague", gstin: null, seatsWritten: null, term: null }),
    );
    expect(vagueGmail.grade).toBe("D");
    expect(vagueCorporate.grade).toBe("D");
  });

  it("does not require a business domain for A+", () => {
    /* THE MEASUREMENT THAT DECIDED THIS. All 28 leads in the live table have `domain` NULL, and
       the webhook path never sets it — so requiring a domain would have made A+ literally
       unreachable while looking like a working feature. */
    const g = gradeLead(facts({ contactEmail: "owner@gmail.com" }));
    expect(g.grade).toBe("A+");
    expect(g.businessDomain).toBeNull();
  });
});

/* ══ The domain that was sitting in the address all along ════════════════════ */

describe("businessDomainFromEmail", () => {
  it.each([
    ["rahul@sharmatraders.in", "sharmatraders.in"],
    ["  Rahul@SharmaTraders.IN  ", "sharmatraders.in"],
    ["accounts@sharma.co.in", "sharma.co.in"],
    ["a.b+tag@sub.example.org", "sub.example.org"],
    ["name@domain.in.", "domain.in"],
  ])("reads %s as %s", (email, expected) => {
    expect(businessDomainFromEmail(email)).toBe(expected);
  });

  it.each([
    ["owner@gmail.com", "Google's domain, not theirs"],
    ["x@yahoo.co.in", "a free Indian mailbox"],
    ["x@rediffmail.com", "a free Indian mailbox"],
    ["x@outlook.com", "a free mailbox"],
    ["x@protonmail.com", "a free mailbox"],
    ["", "empty"],
    [null, "null"],
    ["nodomain", "no @"],
    ["@nolocal.in", "no local part"],
    ["x@nodot", "no dot"],
    ["x@has space.in", "whitespace"],
  ])("returns null for %s (%s)", (email, why) => {
    /* A free mailbox returns NULL rather than "gmail.com" on purpose. Handing gmail.com to the
       MX lookup would produce "gmail.com's mail is handled by Google Workspace" — a machine
       reading the obvious back to a customer — and no part of a switch conversation applies to
       a domain the customer does not own. */
    expect(businessDomainFromEmail(email), `should refuse: ${why}`).toBeNull();
  });

  it("knows the free providers an Indian SME actually uses", () => {
    for (const d of ["gmail.com", "yahoo.co.in", "rediffmail.com", "hotmail.com", "icloud.com"]) {
      expect(isFreeMailbox(d), d).toBe(true);
    }
    expect(isFreeMailbox("sharmatraders.in")).toBe(false);
    expect(isFreeMailbox("GMAIL.COM")).toBe(true);
  });
});

/* ══ The grades ══════════════════════════════════════════════════════════════ */

describe("gradeLead", () => {
  it("gives A+ to a registered business with the seat count, the term and a clear ask", () => {
    const g = gradeLead(facts());
    expect(g.grade).toBe("A+");
    expect(g.route).toBe("quote_now");
    expect(g.callEligible).toBe(true);
  });

  it("will not give A+ without a stated TERM, however big the deal", () => {
    /* Monthly and annual differ by twelve times, and mergeQualification will not price without
       it. A grade that said "quote now" on a deal that cannot be priced would be a grade
       disagreeing with the app. */
    const g = gradeLead(facts({ term: null, seatsWritten: 200 }));
    expect(g.grade).not.toBe("A+");
    expect(g.route).toBe("ask_the_one_question");
  });

  it("will not give A+ on an INFERRED seat count", () => {
    /* seatsWritten is null when the qualifier worked the number out rather than reading it —
       see mergeQualification. A grade built on a number nobody typed would put a machine on the
       phone about a deal size the customer never named. */
    const g = gradeLead(facts({ seatsWritten: null }));
    expect(g.grade).not.toBe("A+");
    expect(g.route).toBe("ask_the_one_question");
  });

  it("treats a checksum-failing GSTIN as unproven, and says so", () => {
    /* Not the same as no GSTIN. CLAUDE.md §7 records a fabricated GSTIN already living in this
       repo, so a number that fails the checksum is a typo or an invention. */
    const g = gradeLead(facts({ gstin: "27AABCE9876D1Z3" }));
    expect(g.grade).not.toBe("A+");
    expect(g.reasons.join(" ")).toContain("does not pass the checksum");
  });

  it("gives D to a vague enquiry with nothing on record", () => {
    const g = gradeLead({
      gstin: null,
      contactEmail: "someone@gmail.com",
      seatsWritten: null,
      term: null,
      clarity: "vague",
      hasPhone: false,
    });
    expect(g.grade).toBe("D");
    expect(g.route).toBe("reply_and_nurture");
    expect(g.callEligible).toBe(false);
  });

  it("never calls a lead with no phone number", () => {
    expect(gradeLead(facts({ hasPhone: false })).callEligible).toBe(false);
  });

  it("scores between 0 and 100, whatever the inputs", () => {
    const extremes = [
      facts(),
      facts({ gstin: null, seatsWritten: null, term: null, clarity: "vague", contactEmail: null }),
      facts({ seatsWritten: 100_000 }),
    ];
    for (const f of extremes) {
      const g = gradeLead(f);
      expect(g.score).toBeGreaterThanOrEqual(0);
      expect(g.score).toBeLessThanOrEqual(100);
    }
  });

  it("gives every grade a reason a person can read", () => {
    /* §24. A letter on a screen with no explanation is a number somebody either over-trusts or
       ignores, and both are worse than the sentence that produced it. */
    for (const clarity of ["specific", "general", "vague"] as const) {
      const g = gradeLead(facts({ clarity }));
      expect(g.reasons.length).toBeGreaterThan(0);
      for (const r of g.reasons) expect(r.length).toBeGreaterThan(15);
    }
  });
});

/* ══ Where the brief's A+ actions collide with rules already in place ════════ */

describe("the A+ actions, measured against what is already built", () => {
  it("routes a 60-seat A+ lead to REVIEW, not to an instant quote", () => {
    /* REVIEW_ABOVE_SEATS is 50: 51–100 seats are priced and drafted in full and then held for a
       person, because that band is where the discount conversation is the deal. So the highest
       grade legitimately gets the slowest route, and the grade says so rather than promising
       something the quote path will not do. */
    const g = gradeLead(facts({ seatsWritten: 60 }));
    expect(g.grade).toBe("A+");
    expect(g.route).toBe("quote_for_review");
    expect(g.reasons.join(" ")).toContain(`Above ${REVIEW_ABOVE_SEATS} seats`);
  });

  it("still quotes an A+ lead inside the band immediately", () => {
    const g = gradeLead(facts({ seatsWritten: REVIEW_ABOVE_SEATS }));
    expect(g.route).toBe("quote_now");
  });

  it("marks a lead CALL-ELIGIBLE and carries no delay of its own", () => {
    /* "Within 10 seconds" cannot be done: decideTelecall obeys quietHoursDecision,
       MIN_HOURS_BETWEEN_CALLS (24) and MAX_CALL_ATTEMPTS (3), because TRAI's TCCCPR governs when
       a business may ring a stranger. An enquiry at 22:45 does not get a call at 22:45. So this
       module answers WHETHER, never WHEN — the grading result has no timing field at all. */
    const g = gradeLead(facts());
    expect(g.callEligible).toBe(true);
    expect(Object.keys(g)).not.toContain("callAfterSeconds");
    expect(Object.keys(g).join(",")).not.toMatch(/second|delay|instant|immediate/i);
  });

  it("the promise guard already refuses the phrase the brief wanted said", () => {
    /* Closure on today's other change: the duration fix earlier today added minutes and seconds
       to DATE_RE, so an agent offering "within 10 seconds" now has its reply held. The brief and
       the guard that stops it landed the same day. */
    expect(findPromises("We will call you within 10 seconds.").safe).toBe(false);
    expect(findPromises("10 second me call aayega.").safe).toBe(false);
  });

  it("uses the brief's own seat threshold for the top band", () => {
    expect(A_PLUS_SEATS).toBe(25);
    expect(gradeLead(facts({ seatsWritten: 24 })).grade).not.toBe("A+");
    expect(gradeLead(facts({ seatsWritten: 25 })).grade).toBe("A+");
  });
});

/* ══ The grade never reaches the model ══════════════════════════════════════ */

describe("a grade is for routing, never for the prompt", () => {
  it("exports a route and reasons, not prompt lines", () => {
    /* A model told "this is a Grade D lead" will write to them like one, and the customer will
       feel it. There is no recoverable version of that leak, so the boundary is structural:
       this module has no *Facts or *Lines export, and sales-agent.ts does not import it. */
    const g = gradeLead(facts());
    expect(Object.keys(g).sort()).toEqual(
      ["businessDomain", "callEligible", "grade", "reasons", "route", "score"].sort(),
    );
  });

  it("summarises the grade in one sentence for a person", () => {
    const g = gradeLead(facts());
    const s = gradeSummary(g);
    expect(s).toContain("Grade A+");
    expect(s).toContain("/100");
    expect(s).toContain("quotation goes out");
    expect(s).toContain("may be called");
  });

  it("names the held path in the summary rather than implying a send", () => {
    expect(gradeSummary(gradeLead(facts({ seatsWritten: 60 })))).toContain("held for a person");
  });
});

/* ══ The route and the grade must never disagree ══════════════════════════════ */

describe("the grade and the route cannot contradict each other", () => {
  it("never routes to a quote when the lead is not priceable", () => {
    /* ─── THE BUG THIS PINS, FOUND BY THE TEST ABOVE ─────────────────────────
       `A` used to require `quotable`, so a lead with a valid GSTIN, TWO HUNDRED seats in
       writing and a clear ask fell to Grade B and was routed to `reply_and_nurture` — nurtured
       because one of four facts was missing, which is the hottest shape a lead can arrive in.

       The fix separated the two questions: the GRADE says how good the lead is, `quotable` says
       whether it can be priced, and the ROUTE comes from both. This walks the whole space to
       check they never disagree again. */
    const grids = [null, "monthly" as const, "annual" as const].flatMap((term) =>
      [null, 10, 30, 60, 200].flatMap((seatsWritten) =>
        [REAL_GSTIN, null].flatMap((gstin) =>
          (["specific", "general", "vague"] as const).map((clarity) =>
            gradeLead({ gstin, contactEmail: "x@y.in", seatsWritten, term, clarity, hasPhone: true }),
          ),
        ),
      ),
    );

    for (const g of grids) {
      const priceable = g.route === "quote_now" || g.route === "quote_for_review";
      if (priceable) {
        /* A quote route may only ever appear on a lead that has both a written seat count and a
           term — everything mergeQualification needs before it will price. */
        expect(g.reasons.join(" "), `${g.grade}/${g.route} was routed to a quote`).toMatch(
          /seats, stated in writing/,
        );
        expect(g.reasons.join(" ")).toMatch(/Billing term confirmed/);
      }
      /* A hot lead is never nurtured when one question would finish it. */
      if ((g.grade === "A+" || g.grade === "A") && !priceable) {
        expect(g.route).toBe("ask_the_one_question");
      }
      /* And a call is never offered to a lead nobody would ring. */
      if (g.callEligible) expect(["A+", "A"]).toContain(g.grade);
    }
  });

  it("routes every grade somewhere", () => {
    const seen = new Set(
      [null, 30, 60].flatMap((seatsWritten) =>
        [REAL_GSTIN, null].flatMap((gstin) =>
          (["specific", "vague"] as const).map(
            (clarity) =>
              gradeLead({ gstin, contactEmail: "x@y.in", seatsWritten, term: "annual", clarity, hasPhone: false })
                .route,
          ),
        ),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
    for (const r of seen) expect(r.length).toBeGreaterThan(0);
  });
});

/* ══ The one line that lights up two features ════════════════════════════════ */

describe("the webhook path derives the domain from the contact address", () => {
  /* ─── THIS TEST EXISTS BECAUSE A MUTATION SURVIVED ────────────────────────
     Reverting run-sales-agent.ts to `domain: lead.domain ?? null` left all 805 tests in
     src/lib/ai green. Not a weak assertion — no test covered the wiring at all, and the
     BEHAVIOUR it changes cannot be reached from a unit test: it needs a database row and a live
     MX lookup. So this reads the source, the way pipeline-wiring.test.ts does.

     What it protects is the difference between two finished-looking features and two features
     that actually run. Measured 25 Aug 2026: all 28 leads in the live table have `domain` NULL,
     because only the trial and public-checkout forms ever write it — and the AI sales agent runs
     on leads the inbound webhooks create. `observeDomain` had been receiving null every time. */
  const src = readFileSync(join(__dirname, "..", "ai", "run-sales-agent.ts"), "utf8");

  it("passes a derived domain to the agent, not just the column", () => {
    expect(src).toContain("businessDomainFromEmail(args.customerContact)");
  });

  it("prefers the COLUMN when it is set", () => {
    /* A domain somebody typed on the checkout form is a deliberate statement; one derived from a
       From: header is an inference — and a contact may write from a different domain than the
       one they are buying for. So the explicit value wins, and the fallback only fills a gap. */
    expect(src).toMatch(/domain:\s*lead\.domain\?\.trim\(\)\s*\|\|\s*businessDomainFromEmail/);
  });

  it("records why the column cannot be relied on", () => {
    /* The next person to read this line will wonder why it is not simply `lead.domain`. */
    expect(src).toContain("THE COLUMN IS EMPTY ON EVERY LEAD THIS PATH EVER SEES");
  });
});
