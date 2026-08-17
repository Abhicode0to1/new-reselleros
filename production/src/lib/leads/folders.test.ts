import { describe, it, expect } from "vitest";
import {
  SALES_FOLDERS, SALES_FLAGS, inSalesFolder, isClosed, isFollowUpDue, isSalesFlag,
  salesFolderCounts, salesFolderValue, type FolderLead,
} from "./folders";
import { HIGH_VALUE } from "./heat";

const TODAY = "2026-08-17";

const lead = (over: Partial<FolderLead> = {}): FolderLead => ({
  stage: "new",
  value: 20_000,
  priority: null,
  is_junk: false,
  follow_up_date: null,
  ...over,
} as FolderLead);

/**
 * ─── THE ONE RULE THIS FILE EXISTS TO PROTECT ───────────────────────────────
 * Folders PARTITION. Every non-junk lead is in exactly one, so the chip numbers a
 * reader adds up actually add up.
 *
 * The first design let folders overlap ("Hot Deals" was a folder), and it was
 * defensible — but Pardeep read "All open 8 · Inbox 7 · Hot 2", added 7+2, got 9,
 * and had to ask three questions before the row made sense. Numbers sitting side by
 * side WILL be added. A row the owner must interrogate has failed, however right it is.
 *
 * Overlap moved into FLAGS (⚡ Hot, ⏰ Due), which are rendered as a separate,
 * differently-styled group after a divider — lenses over the folders, not places.
 */
describe("folders partition — every lead has exactly one home", () => {
  const everyKind: FolderLead[] = [
    lead(),
    lead({ stage: "contact" }),
    lead({ stage: "quote" }),
    lead({ stage: "demo" }),
    lead({ stage: "trial" }),
    lead({ stage: "won" }),
    lead({ stage: "lost" }),
    lead({ value: 500_000, priority: "high", follow_up_date: "2026-01-01" }), // hot AND due
  ];

  it("puts every non-junk lead in EXACTLY one folder, whatever else is true of it", () => {
    for (const l of everyKind) {
      const homes = SALES_FOLDERS.filter((f) => inSalesFolder(l, f.id, TODAY));
      expect(homes).toHaveLength(1);
    }
  });

  it("puts junk in NO folder — the 🚫 view is its only home", () => {
    const junk = lead({ is_junk: true, stage: "quote", value: 900_000, follow_up_date: "2026-01-01" });
    const homes = SALES_FOLDERS.filter((f) => inSalesFolder(junk, f.id, TODAY));
    expect(homes).toHaveLength(0);
  });

  it("therefore the folder counts of any open set sum to the set", () => {
    const open = everyKind.filter((l) => !isClosed(l));
    const c = salesFolderCounts(open, TODAY);
    expect(c.inbox + c.talks + c.quoted + c.proving).toBe(open.length);
  });

  it("keeps flags OUT of the folder list, and folders out of the flag list", () => {
    for (const f of SALES_FOLDERS) expect(isSalesFlag(f.id)).toBe(false);
    for (const f of SALES_FLAGS) expect(isSalesFlag(f.id)).toBe(true);
  });
});

describe("the folder chips walk the funnel in order", () => {
  it("Inbox → In Talks → Quote Sent → Demo/Trial → Won → Lost", () => {
    expect(SALES_FOLDERS.map((f) => f.id)).toEqual(
      ["inbox", "talks", "quoted", "proving", "won", "lost"]);
  });

  it("gives every folder and flag a line for when it is empty", () => {
    for (const f of [...SALES_FOLDERS, ...SALES_FLAGS]) {
      expect(f.hint.length).toBeGreaterThan(20);
    }
  });
});

describe("each folder holds its stage", () => {
  it("inbox: untouched only", () => {
    expect(inSalesFolder(lead(), "inbox", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ stage: "contact" }), "inbox", TODAY)).toBe(false);
  });

  it("talks: contacted only", () => {
    expect(inSalesFolder(lead({ stage: "contact" }), "talks", TODAY)).toBe(true);
    expect(inSalesFolder(lead(), "talks", TODAY)).toBe(false);
  });

  it("proving: demo and trial together — both mean 'being convinced'", () => {
    expect(inSalesFolder(lead({ stage: "demo" }), "proving", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ stage: "trial" }), "proving", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ stage: "quote" }), "proving", TODAY)).toBe(false);
  });

  it("won holds only won; lost holds only lost — junk in neither", () => {
    expect(inSalesFolder(lead({ stage: "won" }), "won", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ stage: "lost" }), "won", TODAY)).toBe(false);
    expect(inSalesFolder(lead({ stage: "lost" }), "lost", TODAY)).toBe(true);
    /* "We competed and lost" and "this was never a real enquiry" are different facts
       leading to different actions — win/loss analysis versus a lead-source problem. */
    expect(inSalesFolder(lead({ is_junk: true }), "lost", TODAY)).toBe(false);
  });
});

describe("⚡ Hot — a flag, so it MAY overlap the folders", () => {
  it("uses heat.ts's own ₹1,00,000 threshold, not a second copy", () => {
    /* A separate number here would drift from the heat badge the rep is looking at
       three inches away, and the flag and the badge would then disagree. */
    expect(HIGH_VALUE).toBe(100_000);
    expect(inSalesFolder(lead({ value: HIGH_VALUE }), "hot", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ value: HIGH_VALUE - 1 }), "hot", TODAY)).toBe(false);
  });

  it("includes a flagged deal that is nowhere near ₹1L", () => {
    /* A rep who marked something high priority said to chase it. */
    expect(inSalesFolder(lead({ value: 20_000, priority: "high", stage: "demo" }), "hot", TODAY)).toBe(true);
  });

  it("overlaps Inbox — a big untouched lead is BOTH new and worth chasing", () => {
    const big = lead({ value: 165_600 });
    expect(inSalesFolder(big, "inbox", TODAY)).toBe(true);
    expect(inSalesFolder(big, "hot", TODAY)).toBe(true);
  });

  it("goes out once the deal is won or lost", () => {
    for (const stage of ["won", "lost"] as const) {
      expect(inSalesFolder(lead({ value: 500_000, stage }), "hot", TODAY)).toBe(false);
    }
  });

  it("keeps JUNK out however large the number on it is", () => {
    /* Someone typing ₹5,00,000 into a spam enquiry must not push it to the top of
       the page — one of those and the rep stops trusting the counts. */
    expect(inSalesFolder(lead({ value: 500_000, is_junk: true }), "hot", TODAY)).toBe(false);
  });
});

describe("⏰ Due — the other flag", () => {
  it("a follow-up dated TODAY is due today", () => {
    expect(isFollowUpDue(lead({ follow_up_date: TODAY }), TODAY)).toBe(true);
  });

  it("includes overdue and excludes future", () => {
    expect(isFollowUpDue(lead({ follow_up_date: "2026-08-10" }), TODAY)).toBe(true);
    expect(isFollowUpDue(lead({ follow_up_date: "2026-08-25" }), TODAY)).toBe(false);
  });

  it("tolerates a timestamp where a date was expected", () => {
    expect(isFollowUpDue(lead({ follow_up_date: "2026-08-17T09:00:00Z" }), TODAY)).toBe(true);
  });

  it("a lead with no follow-up date is not overdue", () => {
    /* Nothing was promised, so nothing is late. */
    expect(isFollowUpDue(lead({ follow_up_date: null }), TODAY)).toBe(false);
  });

  it("stops chasing a deal that is already closed", () => {
    for (const over of [{ stage: "won" as const }, { stage: "lost" as const }, { is_junk: true }]) {
      expect(isFollowUpDue(lead({ follow_up_date: "2026-08-01", ...over }), TODAY)).toBe(false);
    }
  });
});

describe("counts and value", () => {
  const leads = [
    lead(),                                                        // inbox
    lead({ stage: "quote", value: 300_000 }),                      // quoted, + hot flag
    lead({ stage: "demo", follow_up_date: "2026-08-01" }),         // proving, + due flag
    lead({ stage: "won", value: 250_000 }),                        // won
    lead({ stage: "lost", value: 90_000 }),                        // lost
    lead({ is_junk: true, value: 900_000 }),                       // no folder at all
  ];

  it("counts folders and flags independently", () => {
    const c = salesFolderCounts(leads, TODAY);
    expect(c.inbox).toBe(1);
    expect(c.talks).toBe(0);
    expect(c.quoted).toBe(1);
    expect(c.proving).toBe(1);
    expect(c.won).toBe(1);
    expect(c.lost).toBe(1);
    expect(c.hot).toBe(1);
    expect(c.followup).toBe(1);
  });

  it("counts Won and Lost only if the caller kept closed leads in the base set", () => {
    /* The page passes `searched` here, not the open-only list. Passing the open list —
       which is what it used to do — makes these two chips read 0 forever, and a chip that
       can only ever say zero is a chip nobody clicks twice. */
    const openOnly = leads.filter((l) => !isClosed(l));
    expect(salesFolderCounts(openOnly, TODAY).won).toBe(0);
    expect(salesFolderCounts(leads, TODAY).won).toBe(1);
  });

  it("adds up the open pipeline in a folder", () => {
    expect(salesFolderValue(leads, "quoted", TODAY)).toBe(300_000);
  });

  it("reports ZERO for won and lost", () => {
    /* A total beside a folder name reads as pipeline. Closed money in it inflates
       the number a rep reports upward. */
    expect(salesFolderValue(leads, "won", TODAY)).toBe(0);
    expect(salesFolderValue(leads, "lost", TODAY)).toBe(0);
  });

  it("treats a missing value as nothing, not as a guess", () => {
    expect(salesFolderValue([lead({ stage: "quote", value: null })], "quoted", TODAY)).toBe(0);
  });
});

describe("isClosed", () => {
  it("covers all three ways a lead stops being work", () => {
    expect(isClosed(lead({ stage: "won" }))).toBe(true);
    expect(isClosed(lead({ stage: "lost" }))).toBe(true);
    expect(isClosed(lead({ is_junk: true }))).toBe(true);
    expect(isClosed(lead())).toBe(false);
  });
});

/**
 * ─── THE LIVE TENANT, RECONCILED — the row must read without questions ──────
 * This is ANUTECH's real shape on 17 Aug 2026: 7 new + 1 contacted open, 2 won,
 * two leads at ₹1,00,000+. Under the first design the row read
 * "All open 8 · Inbox 7 · Hot 2" and 7+2=9 needed an explanation. Under the
 * partition it reads 7+1+0+0 = 8, and the flags sit apart where nobody sums them.
 */
describe("the live band adds up now", () => {
  const live: FolderLead[] = [
    lead({ value: 0 }),
    lead({ value: 16_320 }), lead({ value: 16_320 }),
    lead({ value: 40_800 }), lead({ value: 11_424 }), lead({ value: 88_320 }),
    lead({ value: 165_600 }),                            // new, carries the hot flag
    lead({ stage: "contact", value: 220_800 }),          // in talks, carries the hot flag
    lead({ stage: "won", value: 439_994 }), lead({ stage: "won", value: 11_470 }),
  ];
  const counts = salesFolderCounts(live, TODAY);
  const open = live.filter((l) => !isClosed(l));

  it("folder chips: 7 + 1 + 0 + 0 = All open 8, and 2 won", () => {
    expect(counts.inbox).toBe(7);
    expect(counts.talks).toBe(1);
    expect(counts.quoted).toBe(0);
    expect(counts.proving).toBe(0);
    expect(counts.inbox + counts.talks + counts.quoted + counts.proving).toBe(open.length);
    expect(counts.won).toBe(2);
  });

  it("flag chips: ⚡2 — and they overlap the folders by design", () => {
    expect(counts.hot).toBe(2);
    /* Pankaj ₹1,65,600 sits in Inbox AND carries ⚡; Manu ₹2,20,800 sits in In Talks
       AND carries ⚡. The flag never removes a lead from its folder. */
    const pankaj = live.find((l) => l.value === 165_600)!;
    expect(inSalesFolder(pankaj, "inbox", TODAY)).toBe(true);
    expect(inSalesFolder(pankaj, "hot", TODAY)).toBe(true);
  });

  it("a follow-up dated tomorrow is not yet due", () => {
    const tomorrow = live.map((l) => lead({ ...l, follow_up_date: "2026-08-18" }));
    expect(salesFolderCounts(tomorrow, TODAY).followup).toBe(0);
  });

  it("totals the open pipeline the band should always have shown", () => {
    /* The band once read ₹0 here — every rupee below belongs to a lead at `new` or
       `contact`, the exact stages the old KPI filter threw away. */
    expect(open.reduce((s, l) => s + (l.value ?? 0), 0)).toBe(559_584);
  });
});
