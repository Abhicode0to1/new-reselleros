import { describe, it, expect } from "vitest";
import { bucketLeads, isOpenLead, nextStep } from "./simple-buckets";
import type { Lead } from "@/lib/supabase/database.types";

/** A lead with only the fields the buckets read. */
const lead = (p: Partial<Lead>): Lead =>
  ({
    id: p.id ?? Math.random().toString(36).slice(2),
    company: p.company ?? "Acme",
    stage: p.stage ?? "contact",
    is_junk: p.is_junk ?? false,
    value: p.value ?? null,
    seats: p.seats ?? null,
    follow_up_date: p.follow_up_date ?? null,
    created_at: p.created_at ?? "2026-08-24T00:00:00Z",
    updated_at: p.updated_at ?? "2026-08-24T00:00:00Z",
    ...p,
  }) as Lead;

/* ══ THE ONE THAT MATTERS ════════════════════════════════════════════════════ */

describe("every lead lands in exactly one bucket", () => {
  it("adds up on the real shape of this workspace", () => {
    /* ─── MEASURED, NOT INVENTED ───────────────────────────────────────────────
       25 Aug 2026, live: 29 leads = 2 open + 12 won + 15 junk records, and those 15
       junk rows also carry stage 'lost'. Counting stage before is_junk is what made
       "junk 15 + won 12 + lost 15" come to 42 against a total of 29. */
    const leads = [
      lead({ company: "Test Company", stage: "quote", value: 81600, seats: 25 }),
      lead({ company: "Sector Tech", stage: "contact", value: 3240, seats: 1, follow_up_date: "2026-08-25" }),
      ...Array.from({ length: 12 }, (_, i) => lead({ company: `W${i} Tech`, stage: "won", value: 1000 + i })),
      ...Array.from({ length: 15 }, (_, i) =>
        lead({ company: ["Kavita Iyer", "Probe Labs", "Arjun Rao"][i % 3], stage: "lost", is_junk: true }),
      ),
    ];

    const b = bucketLeads(leads);
    expect(b.counts.total).toBe(29);
    expect(b.counts.todo).toBe(2);
    expect(b.counts.won).toBe(12);
    expect(b.counts.duplicateRecords).toBe(15);
    expect(b.counts.closedOther).toBe(0);
    expect(b.everyLeadPlaced).toBe(true);
  });

  it("does NOT drop a lead that is lost but not junk", () => {
    /* A three-way split (open / won / junk) loses this row silently. There are zero of
       them in the workspace today, so the bug would have stayed invisible until the
       first real lost deal — and then the total would just be quietly wrong. */
    const b = bucketLeads([
      lead({ stage: "lost", is_junk: false, company: "Genuinely Lost Ltd" }),
      lead({ stage: "won" }),
      lead({ stage: "contact" }),
    ]);
    expect(b.counts.closedOther).toBe(1);
    expect(b.closedOther[0]?.company).toBe("Genuinely Lost Ltd");
    expect(b.everyLeadPlaced).toBe(true);
  });

  it("counts a junk row ONCE even though it also carries a stage", () => {
    /* Every junk lead in this workspace is also stage 'lost'. It belongs to one bucket. */
    const b = bucketLeads([lead({ is_junk: true, stage: "lost" }), lead({ is_junk: true, stage: "won" })]);
    expect(b.counts.duplicateRecords).toBe(2);
    expect(b.counts.won).toBe(0);
    expect(b.counts.closedOther).toBe(0);
    expect(b.everyLeadPlaced).toBe(true);
  });

  it("adds up on an empty workspace, and on one lead", () => {
    expect(bucketLeads([]).everyLeadPlaced).toBe(true);
    expect(bucketLeads([]).counts.total).toBe(0);
    expect(bucketLeads([lead({})]).everyLeadPlaced).toBe(true);
  });

  it("holds for every stage the enum allows", () => {
    /* If a stage is added later and nothing handles it, this fails instead of the total
       being quietly short by one. */
    const stages = ["new", "contact", "demo", "trial", "quote", "won", "lost"] as const;
    const b = bucketLeads(stages.map((stage) => lead({ stage })));
    expect(b.counts.total).toBe(7);
    expect(b.everyLeadPlaced).toBe(true);
  });
});

/* ══ Duplicate grouping ══════════════════════════════════════════════════════ */

describe("junk is grouped into the people it actually is", () => {
  it("turns 15 records into 6 rows", () => {
    const names = ["Kavita Iyer", "Kavita Iyer", "Kavita Iyer", "Kavita Iyer",
                   "Probe Labs", "Probe Labs", "Probe Labs",
                   "Arjun Rao", "Arjun Rao", "Neha Kapoor", "Neha Kapoor",
                   "Ramesh Bhat", "Ramesh Bhat", "Rohit Mehra", "Rohit Mehra"];
    const b = bucketLeads(names.map((company) => lead({ company, is_junk: true, stage: "lost" })));
    expect(b.counts.duplicateRecords).toBe(15);
    expect(b.counts.duplicatePeople).toBe(6);
    /* Worst duplication first — that is the row worth merging. */
    expect(b.duplicates[0]?.company).toBe("Kavita Iyer");
    expect(b.duplicates[0]?.records).toHaveLength(4);
  });

  it("keeps a seat count from whichever record has one", () => {
    /* A merge needs something to keep; if one duplicate carried the seats, that is the
       fact worth surfacing on the row. */
    const b = bucketLeads([
      lead({ company: "Neha Kapoor", is_junk: true, seats: null }),
      lead({ company: "Neha Kapoor", is_junk: true, seats: 60 }),
    ]);
    expect(b.duplicates[0]?.seats).toBe(60);
  });

  it("does not merge two different companies, and names a blank one", () => {
    const b = bucketLeads([
      lead({ company: "A", is_junk: true }),
      lead({ company: "B", is_junk: true }),
      lead({ company: "   ", is_junk: true }),
    ]);
    expect(b.counts.duplicatePeople).toBe(3);
    expect(b.duplicates.some((d) => d.company === "(no name)")).toBe(true);
  });
});

/* ══ Order ═══════════════════════════════════════════════════════════════════ */

describe("what to do first", () => {
  it("puts a dated follow-up ahead of an undated lead, whatever it is worth", () => {
    /* Sector Tech is ₹3,240 with a follow-up due today; Test Company is ₹81,600 with no
       date at all. The dated one goes first — the promise outranks the size. */
    const dated = lead({ company: "Sector Tech", value: 3240, follow_up_date: "2026-08-25" });
    const undated = lead({ company: "Test Company", value: 81600, follow_up_date: null });
    expect(bucketLeads([undated, dated]).todo.map((l) => l.company)).toEqual([
      "Sector Tech",
      "Test Company",
    ]);
  });

  it("orders two dated leads by date, earliest first", () => {
    const later = lead({ company: "Later", follow_up_date: "2026-08-28" });
    const sooner = lead({ company: "Sooner", follow_up_date: "2026-08-25" });
    expect(bucketLeads([later, sooner]).todo.map((l) => l.company)).toEqual(["Sooner", "Later"]);
  });

  it("breaks a tie with the longest-untouched row", () => {
    const fresh = lead({ company: "Fresh", updated_at: "2026-08-25T10:00:00Z" });
    const stale = lead({ company: "Stale", updated_at: "2026-08-20T10:00:00Z" });
    expect(bucketLeads([fresh, stale]).todo.map((l) => l.company)).toEqual(["Stale", "Fresh"]);
  });

  it("shows won deals biggest first", () => {
    const b = bucketLeads([
      lead({ company: "Small", stage: "won", value: 100 }),
      lead({ company: "Big", stage: "won", value: 900 }),
    ]);
    expect(b.won.map((l) => l.company)).toEqual(["Big", "Small"]);
  });
});

/* ══ Money ═══════════════════════════════════════════════════════════════════ */

describe("the totals", () => {
  it("sums open and won separately, treating a missing value as zero", () => {
    const b = bucketLeads([
      lead({ stage: "quote", value: 81600 }),
      lead({ stage: "contact", value: 3240 }),
      lead({ stage: "contact", value: null }),
      lead({ stage: "won", value: 17700 }),
    ]);
    expect(b.openValue).toBe(84840);
    expect(b.wonValue).toBe(17700);
  });

  it("never counts a junk record's value into the open total", () => {
    const b = bucketLeads([lead({ is_junk: true, value: 999999 }), lead({ stage: "contact", value: 100 })]);
    expect(b.openValue).toBe(100);
  });
});

/* ══ The next step ═══════════════════════════════════════════════════════════ */

describe("nextStep says a verb, never a stage name", () => {
  it("asks for a day when a quote is out with no follow-up", () => {
    const s = nextStep({ stage: "quote", follow_up_date: null, created_at: "2026-08-22" });
    expect(s.action).toBe("Pick a day");
    expect(s.unscheduled).toBe(true);
    expect(s.because).toContain("nothing is chasing it");
  });

  it("asks for a call when the quote is out and a day was chosen", () => {
    const s = nextStep({ stage: "quote", follow_up_date: "2026-08-25", created_at: "2026-08-22" });
    expect(s.action).toBe("Call them");
    expect(s.unscheduled).toBe(false);
  });

  it("asks for a quote when nothing has been priced", () => {
    for (const stage of ["new", "contact"] as const) {
      expect(nextStep({ stage, follow_up_date: null, created_at: "2026-08-25" }).action).toBe("Send a quote");
    }
  });

  it("checks in on a trial", () => {
    for (const stage of ["demo", "trial"] as const) {
      expect(nextStep({ stage, follow_up_date: null, created_at: "2026-08-25" }).action).toBe("Check in");
    }
  });

  it("never puts a stage name in front of the user", () => {
    /* ─── WHICH WORDS ARE ACTUALLY JARGON — narrowed TWICE, by failing ────────
       The first version forbade all five stage names and failed on "Send a quote".
       The second still failed on "before the trial runs out". Both failures were
       right by the rule and wrong in substance: quote, trial, demo and new are
       ordinary words a reseller says out loud every day.

       Exactly ONE stage name carries no meaning outside this schema: `contact`.
       Nobody says "this lead is a contact" to mean "we have spoken to them but
       priced nothing". That is the word that must never reach the screen, and it
       is what this test now pins. Narrowing a test until it passes is usually the
       wrong move — here the first two versions were testing a rule nobody wanted. */
    const stages = ["new", "contact", "demo", "trial", "quote"] as const;
    for (const stage of stages) {
      for (const follow_up_date of [null, "2026-08-25"]) {
        const s = nextStep({ stage, follow_up_date, created_at: "2026-08-25" });
        const said = `${s.action} ${s.because}`.toLowerCase();
        expect(said, `${stage}/${follow_up_date}`).not.toMatch(/\bcontact/);
      }
    }
  });
});

describe("isOpenLead", () => {
  it("is open only when it is neither closed nor junk", () => {
    expect(isOpenLead({ stage: "contact", is_junk: false })).toBe(true);
    expect(isOpenLead({ stage: "quote", is_junk: false })).toBe(true);
    expect(isOpenLead({ stage: "won", is_junk: false })).toBe(false);
    expect(isOpenLead({ stage: "lost", is_junk: false })).toBe(false);
    expect(isOpenLead({ stage: "contact", is_junk: true })).toBe(false);
  });
});
