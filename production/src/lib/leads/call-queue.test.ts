import { describe, it, expect } from "vitest";
import { buildCallQueue, queueWhatsAppMessage, dialable } from "./call-queue";
import type { Lead } from "@/lib/supabase/database.types";

const NOW = new Date(2026, 7, 14, 10, 0);       // 14 Aug 2026, local
const TODAY = "2026-08-14";

let n = 0;
const lead = (over: Partial<Lead> = {}): Lead => ({
  id: `L${++n}`, company: `Co ${n}`, contact_phone: "+91 98111 22233",
  contact_email: "a@acme.in", domain: null, seats: 10, source: "website",
  stage: "contact", value: 50_000, priority: "medium", is_junk: false,
  follow_up_date: TODAY, created_at: TODAY, updated_at: TODAY,
  ...over,
} as unknown as Lead);

describe("buildCallQueue — who is in it", () => {
  it("includes leads due today", () => {
    const q = buildCallQueue([lead({ company: "Due" })], 3, NOW);
    expect(q.entries.map((e) => e.lead.company)).toEqual(["Due"]);
    expect(q.dueCount).toBe(1);
  });

  it("INCLUDES overdue leads — they are more urgent, not less", () => {
    /* A queue showing only exactly-today would bury the lead a rep promised to call
       last Tuesday behind the one promised this morning. */
    const q = buildCallQueue([lead({ company: "Late", follow_up_date: "2026-08-07" })], 3, NOW);
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0].daysOverdue).toBe(7);
    expect(q.overdueCount).toBe(1);
  });

  it("excludes leads scheduled for the future", () => {
    const q = buildCallQueue([lead({ follow_up_date: "2026-09-01" })], 3, NOW);
    expect(q.entries).toHaveLength(0);
    expect(q.dueCount).toBe(0);
  });

  it("excludes leads with no follow-up date at all", () => {
    // Not due is not the same as overdue. An unscheduled lead is a different problem.
    expect(buildCallQueue([lead({ follow_up_date: null })], 3, NOW).dueCount).toBe(0);
  });

  it("excludes junk and finished deals", () => {
    const leads = [
      lead({ company: "Junk", is_junk: true }),
      lead({ company: "Won",  stage: "won" }),
      lead({ company: "Lost", stage: "lost" }),
      lead({ company: "Real" }),
    ];
    expect(buildCallQueue(leads, 5, NOW).entries.map((e) => e.lead.company)).toEqual(["Real"]);
  });
});

describe("buildCallQueue — a lead with no phone is reported, not hidden", () => {
  it("keeps it out of the dialling list but surfaces it separately", () => {
    /* The Call button would be a button that cannot work. But dropping it silently
       means nobody ever adds the number — a two-second fix. */
    const q = buildCallQueue([
      lead({ company: "No Phone", contact_phone: null }),
      lead({ company: "Blank Phone", contact_phone: "   " }),
      lead({ company: "Callable" }),
    ], 5, NOW);
    expect(q.entries.map((e) => e.lead.company)).toEqual(["Callable"]);
    expect(q.dueWithoutPhone.map((l) => l.company)).toEqual(["No Phone", "Blank Phone"]);
    expect(q.dueCount).toBe(1);
  });
});

describe("buildCallQueue — ordering", () => {
  it("most overdue first", () => {
    const q = buildCallQueue([
      lead({ company: "1 day",  follow_up_date: "2026-08-13" }),
      lead({ company: "9 days", follow_up_date: "2026-08-05" }),
      lead({ company: "today",  follow_up_date: TODAY }),
    ], 3, NOW);
    expect(q.entries.map((e) => e.lead.company)).toEqual(["9 days", "1 day", "today"]);
  });

  it("then by heat score — a corporate 200-seat lead outranks a Gmail 2-seat one", () => {
    const q = buildCallQueue([
      lead({ company: "Weak",   contact_email: "x@gmail.com", seats: 2,   source: "csv" }),
      lead({ company: "Strong", contact_email: "x@tatamotors.com", seats: 200, source: "referral" }),
    ], 3, NOW);
    expect(q.entries.map((e) => e.lead.company)).toEqual(["Strong", "Weak"]);
    expect(q.entries[0].heat.score).toBeGreaterThan(q.entries[1].heat.score);
  });

  it("then by value when heat ties", () => {
    const same = { contact_email: "x@acme.in", seats: 10, source: "website" };
    const q = buildCallQueue([
      lead({ company: "Small", ...same, value: 10_000 }),
      lead({ company: "Big",   ...same, value: 900_000 }),
    ], 3, NOW);
    expect(q.entries.map((e) => e.lead.company)).toEqual(["Big", "Small"]);
  });

  it("is a TOTAL order — identical leads never reshuffle between renders", () => {
    /* In a 1-tap call bar an unstable sort means the rep taps Call on the lead that
       was there a moment ago. Company name is the final tiebreak. */
    const twins = [lead({ company: "Zeta" }), lead({ company: "Alpha" })];
    const a = buildCallQueue(twins, 3, NOW).entries.map((e) => e.lead.company);
    const b = buildCallQueue([...twins].reverse(), 3, NOW).entries.map((e) => e.lead.company);
    expect(a).toEqual(["Alpha", "Zeta"]);
    expect(b).toEqual(a);
  });
});

describe("buildCallQueue — the top-N cut is visible", () => {
  it("returns 3 but reports the true total, so the bar can say '3 of 11'", () => {
    // Silent truncation reads as "that is everything" when it is not.
    const many = Array.from({ length: 11 }, (_, i) => lead({ company: `C${i}` }));
    const q = buildCallQueue(many, 3, NOW);
    expect(q.entries).toHaveLength(3);
    expect(q.dueCount).toBe(11);
  });

  it("honours a different limit, and a limit of zero returns nothing", () => {
    const many = Array.from({ length: 5 }, () => lead());
    expect(buildCallQueue(many, 5, NOW).entries).toHaveLength(5);
    expect(buildCallQueue(many, 0, NOW).entries).toHaveLength(0);
    expect(buildCallQueue(many, -1, NOW).entries).toHaveLength(0);
  });

  it("an empty inbox produces an empty queue, not an error", () => {
    const q = buildCallQueue([], 3, NOW);
    expect(q).toEqual({ entries: [], dueCount: 0, dueWithoutPhone: [], overdueCount: 0 });
  });
});

describe("dialable — what goes into tel: and wa.me", () => {
  it("strips formatting", () => {
    expect(dialable("+91 98111 22233")).toBe("919811122233");
    expect(dialable("098111-22233")).toBe("919811122233");
  });

  it("drops the domestic trunk 0 before adding 91", () => {
    /* "(011) 4567-8901" is how an Indian landline is written at home. Passing it
       through as 01145678901 makes wa.me fail silently. The first version of the test
       above asserted a contrived expression, and that is what surfaced this case. */
    expect(dialable("(011) 4567-8901")).toBe("911145678901");
  });

  it("assumes +91 for a bare 10-digit Indian number", () => {
    expect(dialable("9811122233")).toBe("919811122233");
  });

  it("leaves an already-prefixed number alone", () => {
    expect(dialable("919811122233")).toBe("919811122233");
  });

  it("refuses anything too short to be a number", () => {
    for (const v of [null, undefined, "", "12345", "n/a", "call office"]) {
      expect(dialable(v as string | null)).toBeNull();
    }
  });
});

describe("queueWhatsAppMessage", () => {
  it("uses the contact's name when there is one", () => {
    const m = queueWhatsAppMessage({ company: "Bright", contact_name: "Ravi", plan: "Google Workspace" } as Lead, "ANUTECH");
    expect(m).toBe("Hi Ravi, following up about Google Workspace for Bright. Is now a good time for a quick call? — ANUTECH");
  });

  it("leaves NO placeholder behind when fields are missing", () => {
    /* The failure mode this avoids is a rep sending "Hi {{name}}" to a customer. */
    const m = queueWhatsAppMessage({ company: "Bright", contact_name: null, plan: null } as Lead, null);
    expect(m).toBe("Hello, following up for Bright. Is now a good time for a quick call?");
    expect(m).not.toMatch(/\{\{|\}\}|undefined|null/);
  });

  it("ignores whitespace-only names and plans", () => {
    const m = queueWhatsAppMessage({ company: "Bright", contact_name: "   ", plan: "  " } as Lead, "  ");
    expect(m).toBe("Hello, following up for Bright. Is now a good time for a quick call?");
  });
});
