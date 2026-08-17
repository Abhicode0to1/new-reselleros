import { describe, it, expect } from "vitest";
import {
  SALES_FOLDERS, inSalesFolder, isClosed, isFollowUpDue,
  salesFolderCounts, salesFolderValue, type FolderLead, type SalesFolder,
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

describe("the folder names a salesperson reads", () => {
  it("carries no stage jargon", () => {
    const labels = SALES_FOLDERS.map((f) => f.label.toLowerCase()).join(" ");
    for (const jargon of ["demo", "trial", "contact", "stage"]) {
      expect(labels).not.toContain(jargon);
    }
  });

  it("gives every folder a line for when it is empty", () => {
    for (const f of SALES_FOLDERS) expect(f.hint.length).toBeGreaterThan(20);
  });
});

describe("Inbox — untouched enquiries", () => {
  it("holds a brand new lead", () => {
    expect(inSalesFolder(lead(), "inbox", TODAY)).toBe(true);
  });

  it("drops it the moment somebody makes contact", () => {
    expect(inSalesFolder(lead({ stage: "contact" }), "inbox", TODAY)).toBe(false);
  });
});

describe("Hot Deals", () => {
  it("uses heat.ts's own ₹1,00,000 threshold, not a second copy", () => {
    /* A separate number here would drift from the heat badge the rep is looking at
       three inches away, and the folder and the badge would then disagree about the
       same lead. */
    expect(HIGH_VALUE).toBe(100_000);
    expect(inSalesFolder(lead({ value: HIGH_VALUE }), "hot", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ value: HIGH_VALUE - 1 }), "hot", TODAY)).toBe(false);
  });

  it("includes a flagged deal that is nowhere near ₹1L", () => {
    /* A rep who marked something high priority said to chase it. */
    expect(inSalesFolder(lead({ value: 20_000, priority: "high", stage: "demo" }), "hot", TODAY)).toBe(true);
  });

  it("keeps a big deal out once it is won or lost", () => {
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

describe("Follow-Up Needed", () => {
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

describe("Won and Archived", () => {
  it("won holds only won", () => {
    expect(inSalesFolder(lead({ stage: "won" }), "won", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ stage: "lost" }), "won", TODAY)).toBe(false);
  });

  it("archived holds lost AND junk", () => {
    /* Junk is filed rather than hidden — it is still a record someone may need to
       find, and hiding it entirely is how a wrongly-junked lead is lost for good. */
    expect(inSalesFolder(lead({ stage: "lost" }), "archived", TODAY)).toBe(true);
    expect(inSalesFolder(lead({ is_junk: true }), "archived", TODAY)).toBe(true);
  });
});

describe("folders overlap, like labels", () => {
  it("a hot lead with a quote out and an overdue follow-up is in three at once", () => {
    const l = lead({ stage: "quote", value: 400_000, follow_up_date: "2026-08-10" });
    const present = SALES_FOLDERS.map((f) => f.id).filter((f) => inSalesFolder(l, f, TODAY));
    expect(present).toEqual(["hot", "quoted", "followup"] as SalesFolder[]);
  });
});

describe("counts and value", () => {
  const leads = [
    lead(),                                                        // inbox
    lead({ stage: "quote", value: 300_000 }),                      // hot + quoted
    lead({ stage: "demo", follow_up_date: "2026-08-01" }),         // followup
    lead({ stage: "won", value: 250_000 }),                        // won
    lead({ stage: "lost", value: 90_000 }),                        // archived
    lead({ is_junk: true, value: 900_000 }),                       // archived
  ];

  it("counts each folder independently", () => {
    const c = salesFolderCounts(leads, TODAY);
    expect(c.inbox).toBe(1);
    expect(c.hot).toBe(1);
    expect(c.quoted).toBe(1);
    expect(c.followup).toBe(1);
    expect(c.won).toBe(1);
    expect(c.archived).toBe(2);
  });

  it("adds up the open pipeline in a folder", () => {
    expect(salesFolderValue(leads, "quoted", TODAY)).toBe(300_000);
  });

  it("reports ZERO for won and archived", () => {
    /* A total beside a folder name reads as pipeline. Closed money in it inflates
       the number a rep reports upward. */
    expect(salesFolderValue(leads, "won", TODAY)).toBe(0);
    expect(salesFolderValue(leads, "archived", TODAY)).toBe(0);
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
 * ─── THE CHIP COUNTS DO NOT ADD UP, AND THAT IS CORRECT ─────────────────────
 * Pardeep read the live band — "All open 8 · Inbox 7 · Hot Deals 2" — and asked how
 * that could possibly be right. 7 + 2 is 9, and there are only 8 leads.
 *
 * It is right because these are LABELS, not buckets. A ₹1,65,600 lead nobody has
 * called yet is in Inbox because it is untouched and in Hot Deals because of the
 * money; both statements are true and the rep needs to see it in both places.
 * Mutually-exclusive folders would force a choice between "new" and "worth chasing",
 * and whichever lost would hide the most valuable lead on the page.
 *
 * This test is the real tenant's shape on 17 Aug 2026, so the arithmetic in the
 * screenshot is pinned rather than re-argued the next time someone counts.
 */
describe("the counts overlap on purpose — the live band, reconciled", () => {
  /* 7 new + 1 contact open, 2 won. Two carry ₹1,00,000 or more. */
  const live: FolderLead[] = [
    lead({ value: 0 }),
    lead({ value: 16_320 }), lead({ value: 16_320 }),
    lead({ value: 40_800 }), lead({ value: 11_424 }), lead({ value: 88_320 }),
    lead({ value: 165_600 }),                            // new AND hot
    lead({ stage: "contact", value: 220_800 }),          // contact AND hot
    lead({ stage: "won", value: 439_994 }), lead({ stage: "won", value: 11_470 }),
  ];
  const open = live.filter((l) => !isClosed(l));
  const counts = salesFolderCounts(open, TODAY);

  it("has 8 open leads out of 10", () => {
    expect(open).toHaveLength(8);
  });

  it("puts 7 in Inbox and 2 in Hot Deals — 9 placements across 8 leads", () => {
    expect(counts.inbox).toBe(7);
    expect(counts.hot).toBe(2);
    expect(counts.inbox + counts.hot).toBeGreaterThan(open.length);
  });

  it("names the lead sitting in both, so the extra placement has an address", () => {
    const both = open.filter(
      (l) => inSalesFolder(l, "inbox", TODAY) && inSalesFolder(l, "hot", TODAY));
    expect(both).toHaveLength(1);
    expect(both[0]!.value).toBe(165_600);
  });

  it("shows the other hot lead is out of Inbox because somebody called it", () => {
    const hotNotInbox = open.filter(
      (l) => inSalesFolder(l, "hot", TODAY) && !inSalesFolder(l, "inbox", TODAY));
    expect(hotNotInbox).toHaveLength(1);
    expect(hotNotInbox[0]!.stage).toBe("contact");
  });

  it("counts a follow-up dated tomorrow as not yet due", () => {
    const tomorrow = live.map((l) => lead({ ...l, follow_up_date: "2026-08-18" }));
    expect(salesFolderCounts(tomorrow.filter((l) => !isClosed(l)), TODAY).followup).toBe(0);
  });

  it("totals the open pipeline the band should have been showing", () => {
    /* The band read ₹0 here. Every rupee below belongs to a lead at `new` or
       `contact` — the exact stages the old KPI filter threw away. */
    expect(open.reduce((s, l) => s + (l.value ?? 0), 0)).toBe(559_584);
  });
});
