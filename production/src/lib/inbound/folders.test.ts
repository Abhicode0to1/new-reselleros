import { describe, it, expect } from "vitest";
import {
  MAIL_FOLDERS, inFolder, isSnoozed, isSpam, folderCounts, inboxUnread, snoozePresets,
  type FoldersRow, type MailFolder,
} from "./folders";

const NOW = "2026-08-17T09:00:00.000Z";

const row = (over: Partial<FoldersRow & { read_at: string | null }> = {}) => ({
  status:        "received",
  lead_id:       null,
  starred:       false,
  snoozed_until: null,
  archived_at:   null,
  read_at:       null,
  ...over,
}) as FoldersRow & { read_at: string | null };

describe("the folder names a salesperson reads", () => {
  it("has no developer jargon left in it", () => {
    /* The page used to offer `untriaged`, `appended` and `skipped` — the webhook's
       words for what IT did. "Appended" tells a rep nothing about whether they owe
       someone a reply. */
    const labels = MAIL_FOLDERS.map((f) => f.label.toLowerCase()).join(" ");
    for (const jargon of ["untriaged", "appended", "skipped", "received"]) {
      expect(labels).not.toContain(jargon);
    }
  });

  it("gives every folder a plain-English line for when it is empty", () => {
    for (const f of MAIL_FOLDERS) expect(f.hint.length).toBeGreaterThan(20);
  });
});

describe("Inbox — what a rep still owes an answer on", () => {
  it("holds a new enquiry", () => {
    expect(inFolder(row(), "inbox", NOW)).toBe(true);
  });

  it("drops it once archived", () => {
    expect(inFolder(row({ archived_at: NOW }), "inbox", NOW)).toBe(false);
  });

  it("hides system and duplicate mail", () => {
    expect(inFolder(row({ status: "skipped_non_enquiry" }), "inbox", NOW)).toBe(false);
    expect(inFolder(row({ status: "duplicate" }), "inbox", NOW)).toBe(false);
  });

  it("KEEPS a mail the pipeline errored on", () => {
    /* The one email a human most needs to see. Filing parser failures as spam is
       how a real enquiry disappears because something threw. */
    expect(inFolder(row({ status: "error" }), "inbox", NOW)).toBe(true);
    expect(isSpam(row({ status: "error" }))).toBe(false);
  });

  it("keeps a converted enquiry until it is actually archived", () => {
    /* Converting to a lead is not the same as being finished with the email — the
       customer may still be waiting on a reply. */
    expect(inFolder(row({ status: "lead_created", lead_id: "L-1" }), "inbox", NOW)).toBe(true);
  });
});

describe("Snoozed — it comes back, that is the whole promise", () => {
  it("leaves the Inbox while the snooze is running", () => {
    const r = row({ snoozed_until: "2026-08-20T09:00:00.000Z" });
    expect(inFolder(r, "inbox", NOW)).toBe(false);
    expect(inFolder(r, "snoozed", NOW)).toBe(true);
  });

  it("returns to the Inbox on its own once the moment passes", () => {
    /* Compared to now on every read, deliberately — a job that flipped a flag could
       fail to run and the mail would never come back. */
    const r = row({ snoozed_until: "2026-08-16T09:00:00.000Z" });
    expect(isSnoozed(r, NOW)).toBe(false);
    expect(inFolder(r, "inbox", NOW)).toBe(true);
    expect(inFolder(r, "snoozed", NOW)).toBe(false);
  });

  it("is not archiving — a snoozed mail is not Done", () => {
    const r = row({ snoozed_until: "2026-08-20T09:00:00.000Z" });
    expect(inFolder(r, "done", NOW)).toBe(false);
  });
});

describe("Starred — a flag that does not vanish when you file the mail", () => {
  it("shows even after the mail is archived", () => {
    const r = row({ starred: true, archived_at: NOW });
    expect(inFolder(r, "starred", NOW)).toBe(true);
    expect(inFolder(r, "inbox", NOW)).toBe(false);
  });

  it("starring does not remove anything from the Inbox", () => {
    expect(inFolder(row({ starred: true }), "inbox", NOW)).toBe(true);
  });
});

describe("Sent", () => {
  it("never claims an inbound email", () => {
    /* Sent mail lives in email_log, which has no body column. The page loads it
       separately and says so — returning rows here would show inbound mail in the
       Sent folder. */
    for (const r of [row(), row({ archived_at: NOW }), row({ starred: true })]) {
      expect(inFolder(r, "sent", NOW)).toBe(false);
    }
  });
});

describe("folders overlap on purpose", () => {
  it("a starred, converted, unarchived enquiry is in three folders at once", () => {
    const r = row({ starred: true, status: "lead_created", lead_id: "L-1" });
    const present = MAIL_FOLDERS.map((f) => f.id).filter((f) => inFolder(r, f, NOW));
    expect(present).toEqual(["inbox", "starred", "leads"] as MailFolder[]);
  });
});

describe("snoozePresets — tomorrow means tomorrow MORNING", () => {
  it("wakes at 09:00 IST, not midnight", () => {
    /* A mail that reappears at 00:01 sits in the Inbox for a whole shift before
       anyone is at a desk — the rep who snoozed it gained nothing. */
    const [tomorrow] = snoozePresets(new Date("2026-08-17T12:00:00.000Z"));
    // 09:00 IST == 03:30 UTC
    expect(tomorrow.untilISO).toBe("2026-08-18T03:30:00.000Z");
  });

  it("still lands on the NEXT morning when snoozed late at night IST", () => {
    /* 23:00 IST on the 17th is 17:30 UTC — the UTC date is still the 17th, so
       arithmetic done in UTC would wake it the same IST evening. */
    const [tomorrow] = snoozePresets(new Date("2026-08-17T17:30:00.000Z"));
    expect(tomorrow.untilISO).toBe("2026-08-18T03:30:00.000Z");
  });

  it("is always in the future", () => {
    const now = new Date("2026-08-17T02:00:00.000Z");
    for (const p of snoozePresets(now)) {
      expect(new Date(p.untilISO).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("a snoozed mail is hidden right up to its moment", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    const [tomorrow] = snoozePresets(now);
    const r = row({ snoozed_until: tomorrow.untilISO });
    expect(isSnoozed(r, "2026-08-18T03:29:59.000Z")).toBe(true);
    expect(isSnoozed(r, "2026-08-18T03:30:01.000Z")).toBe(false);
  });
});

describe("counts", () => {
  const rows = [
    row(),                                                   // inbox
    row({ starred: true }),                                  // inbox + starred
    row({ status: "lead_created", lead_id: "L-1" }),          // inbox + leads
    row({ archived_at: NOW }),                                // done
    row({ status: "skipped_non_enquiry" }),                   // spam
    row({ snoozed_until: "2026-08-20T09:00:00.000Z" }),       // snoozed
  ];

  it("counts each folder independently", () => {
    const c = folderCounts(rows, NOW);
    expect(c.inbox).toBe(3);
    expect(c.starred).toBe(1);
    expect(c.leads).toBe(1);
    expect(c.done).toBe(1);
    expect(c.spam).toBe(1);
    expect(c.snoozed).toBe(1);
    expect(c.sent).toBe(0);
  });

  it("the unread badge counts only work still in the Inbox", () => {
    /* "12 unread" has to mean twelve things to do. Counting unread mail that is
       archived or snoozed inflates it with work already handled. */
    const withRead = [
      row({ read_at: null }),
      row({ read_at: NOW }),
      row({ read_at: null, archived_at: NOW }),
      row({ read_at: null, snoozed_until: "2026-08-20T09:00:00.000Z" }),
      row({ read_at: null, status: "skipped_non_enquiry" }),
    ];
    expect(inboxUnread(withRead, NOW)).toBe(1);
  });
});
