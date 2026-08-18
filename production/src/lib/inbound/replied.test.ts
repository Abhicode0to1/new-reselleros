import { describe, it, expect } from "vitest";
import { repliedState, repliedNote, repliedIsProblem, type ReplyRef } from "./replied";

const EMAIL_AT = "2026-08-17T09:00:00.000Z";
const when = (iso: string) => iso.slice(0, 10);

const sentAt = (iso: string, status = "sent"): ReplyRef => ({ sentAt: iso, status });

describe("nothing sent yet", () => {
  it("is 'none' with an empty log", () => {
    expect(repliedState(EMAIL_AT, [])).toEqual({ kind: "none" });
    expect(repliedNote(repliedState(EMAIL_AT, []), when)).toBeNull();
  });

  it("mail sent BEFORE this email is not a reply to it", () => {
    /* Same rule as answered.ts. A customer quoted last month who has now written again is
       waiting, and treating the old thread as an answer would hide the one enquiry that
       needs work. */
    const old = repliedState(EMAIL_AT, [sentAt("2026-07-01T10:00:00.000Z")]);
    expect(old.kind).toBe("none");
  });

  it("counts a reply sent in the SAME second the email landed", () => {
    /* What a fast operator working straight from the reading pane produces. */
    expect(repliedState(EMAIL_AT, [sentAt(EMAIL_AT)]).kind).toBe("replied");
  });
});

describe("a reply that actually left", () => {
  it("names the date of the last one", () => {
    const s = repliedState(EMAIL_AT, [sentAt("2026-08-17T09:30:00.000Z")]);
    expect(repliedNote(s, when)).toBe("You already replied to this on 2026-08-17.");
    expect(repliedIsProblem(s)).toBe(false);
  });

  it("says HOW MANY when there is more than one — that is the mistake being prevented", () => {
    const s = repliedState(EMAIL_AT, [
      sentAt("2026-08-17T09:30:00.000Z"),
      sentAt("2026-08-17T11:00:00.000Z"),
    ]);
    expect(s).toMatchObject({ kind: "replied", count: 2 });
    expect(repliedNote(s, when)).toContain("2 times");
  });

  it("reports the LATEST as last, whatever order the log comes back in", () => {
    const s = repliedState(EMAIL_AT, [
      sentAt("2026-08-17T15:00:00.000Z"),
      sentAt("2026-08-17T09:30:00.000Z"),
    ]);
    expect(s.kind === "replied" && s.last.sentAt).toBe("2026-08-17T15:00:00.000Z");
  });
});

/**
 * ─── THE ONE THAT MATTERS ───────────────────────────────────────────────────
 * A stub send writes a perfectly ordinary-looking row. If it counted as a reply, the
 * screen would tell a reseller their customer has been answered while the customer has
 * heard nothing at all.
 */
describe("an attempt that never left is NOT a reply", () => {
  it("a stubbed send is reported apart, and as a problem", () => {
    const s = repliedState(EMAIL_AT, [sentAt("2026-08-17T09:30:00.000Z", "stubbed")]);
    expect(s.kind).toBe("attempted-only");
    expect(repliedIsProblem(s)).toBe(true);
    expect(repliedNote(s, when)).toMatch(/did not go out/i);
    expect(repliedNote(s, when)).not.toMatch(/you already replied/i);
  });

  it("a failed send is the same", () => {
    expect(repliedState(EMAIL_AT, [sentAt("2026-08-17T09:30:00.000Z", "failed")]).kind)
      .toBe("attempted-only");
  });

  it("one real send outranks any number of failures", () => {
    /* The customer has the email. That is the fact worth stating. */
    const s = repliedState(EMAIL_AT, [
      sentAt("2026-08-17T09:10:00.000Z", "failed"),
      sentAt("2026-08-17T09:20:00.000Z", "sent"),
      sentAt("2026-08-17T09:30:00.000Z", "failed"),
    ]);
    expect(s).toMatchObject({ kind: "replied", count: 1 });
    expect(s.kind === "replied" && s.last.sentAt).toBe("2026-08-17T09:20:00.000Z");
  });

  it("the failure note tells the operator what to DO — §24", () => {
    const s = repliedState(EMAIL_AT, [sentAt("2026-08-17T09:30:00.000Z", "stubbed")]);
    expect(repliedNote(s, when)).toMatch(/send it again/i);
  });
});
