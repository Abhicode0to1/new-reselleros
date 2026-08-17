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
