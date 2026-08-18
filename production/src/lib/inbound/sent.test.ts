import { describe, it, expect } from "vitest";
import { SENT_REPLY_STATUS, isSentReply, sentFromNote } from "./sent";
import { inFolder, folderCounts, MAIL_FOLDERS, type FoldersRow } from "./folders";

const NOW = "2026-08-18T05:00:00.000Z";

const row = (over: Partial<FoldersRow> = {}): FoldersRow => ({
  status: "lead_created", lead_id: null,
  starred: false, snoozed_until: null, archived_at: null,
  ...over,
});

const SENT = row({ status: SENT_REPLY_STATUS, lead_id: "L-MST0UUN1" });

describe("a reply we sent", () => {
  it("is recognised by its status", () => {
    expect(isSentReply(SENT)).toBe(true);
    expect(isSentReply(row())).toBe(false);
  });

  it("appears in Sent", () => {
    expect(inFolder(SENT, "sent", NOW)).toBe(true);
  });

  /**
   * The one that matters. Our own outgoing mail sitting in the Inbox would read as work
   * somebody still owes an answer on, and would inflate every count on the rail.
   */
  it("appears in NO other folder — not even Converted Leads, which it would otherwise match", () => {
    for (const f of MAIL_FOLDERS) {
      if (f.id === "sent") continue;
      expect(inFolder(SENT, f.id, NOW), `should not be in ${f.id}`).toBe(false);
    }
  });

  it("stays out of the Inbox even when starred or unarchived", () => {
    const starred = row({ status: SENT_REPLY_STATUS, starred: true });
    expect(inFolder(starred, "inbox", NOW)).toBe(false);
    expect(inFolder(starred, "starred", NOW)).toBe(false);
  });

  it("is counted in Sent and nowhere else", () => {
    const counts = folderCounts([SENT, row(), row({ lead_id: "L-2" })], NOW);
    expect(counts.sent).toBe(1);
    /* Two inbound rows, and our reply is not one of them. */
    expect(counts.inbox).toBe(2);
    expect(counts.leads).toBe(1);
  });
});

describe("an inbound enquiry", () => {
  it("is never in Sent", () => {
    expect(inFolder(row(), "sent", NOW)).toBe(false);
    expect(inFolder(row({ archived_at: NOW }), "sent", NOW)).toBe(false);
  });
});

/**
 * ─── THE LINE THAT ANSWERS THE ACTUAL CONFUSION ─────────────────────────────
 * Pardeep sent a reply and then went looking for it in sales@anutech.in. It was never
 * going there: the connected account is pardeep@anutech.in, so the copy is in THAT
 * account's Sent folder and the reply itself went to the customer.
 */
describe("where the copy actually is", () => {
  it("names the account it left from", () => {
    const note = sentFromNote("pardeep@anutech.in");
    expect(note).toContain("pardeep@anutech.in");
    expect(note).toMatch(/Sent folder/i);
  });

  it("does NOT name a likely address when none is known", () => {
    /* Sending someone to hunt the wrong mailbox is worse than saying you do not know. */
    for (const unknown of [null, undefined, "   "]) {
      const note = sentFromNote(unknown);
      expect(note).not.toMatch(/@/);
      expect(note).toMatch(/Settings/i);
    }
  });
});
