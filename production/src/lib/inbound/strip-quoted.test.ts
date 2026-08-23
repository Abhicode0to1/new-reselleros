import { describe, it, expect } from "vitest";
import { stripQuoted } from "./strip-quoted";

/* The message this module was written for, copied from the row in inbound_emails
   (lead L-MT4HUR6P, 22 Aug 2026 16:29 UTC). Both "20" and "50" appear, and both
   product names — which is the whole problem. */
const REAL_REPLY = `Hi,

Actually, I need the quotation for 20 users of Google Workspace Business
Standard, not 50 users of Starter. Please adjust that.

On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:

> Hi test,
>
> Thank you for your enquiry for 50 users of Google Workspace Business
> Starter. I am preparing the quotation now and will send it across shortly.
>
> If the number of users changes before then, just reply here and I will adjust it.
>
> Best regards,
> ANUTECH DIGITAL PVT LTD`;

describe("stripQuoted", () => {
  it("keeps what the customer just wrote and drops our previous message", () => {
    const { text, removedQuote } = stripQuoted(REAL_REPLY);
    expect(removedQuote).toBe(true);
    expect(text).toContain("20 users");
    expect(text).toContain("Standard");
    /* The load-bearing assertion. "50" survives ONLY as part of the customer's own
       phrase "not 50 users of Starter" — never as the quoted enquiry, whose whole
       sentence must be gone. */
    expect(text).not.toContain("Thank you for your enquiry");
    expect(text).not.toContain("ANUTECH DIGITAL PVT LTD");
    expect(text).not.toContain("Best regards");
  });

  it("does not leak our sign-off or the quote markers", () => {
    const { text } = stripQuoted(REAL_REPLY);
    expect(text).not.toMatch(/^\s*>/m);
    expect(text).not.toMatch(/wrote:/);
  });

  it("cuts at the EARLIEST marker, not the first pattern in the list", () => {
    /* A Gmail quote whose quoted content itself contains "-----Original Message-----".
       Matching by list order would keep the Gmail block above it. */
    const s = stripQuoted(
      `My new text.\n\nOn Mon, 1 Jan 2026, a@b.in wrote:\n> old\n-----Original Message-----\n> older`,
    );
    expect(s.text).toBe("My new text.");
  });

  it("handles Outlook's original-message divider", () => {
    const s = stripQuoted("Please make it 20.\n\n-----Original Message-----\nFrom: x\n50 users");
    expect(s.text).toBe("Please make it 20.");
    expect(s.removedQuote).toBe(true);
  });

  it("handles Outlook's From:/Sent: header block", () => {
    const s = stripQuoted("Twenty please.\n\nFrom: sales@anutech.in\nSent: Saturday\nTo: me\n\n50 users of Starter");
    expect(s.text).toBe("Twenty please.");
  });

  it("handles the underscore divider", () => {
    const s = stripQuoted("20 users.\n\n________________________________\nFrom: someone\n50 users");
    expect(s.text).toBe("20 users.");
  });

  it("drops a trailing quoted block with no header line at all", () => {
    /* Some clients just prefix `>` and give no "On … wrote:" line. */
    const s = stripQuoted("Make it 20.\n\n> Thank you for your enquiry for 50 users\n> of Starter.");
    expect(s.text).toBe("Make it 20.");
    expect(s.removedQuote).toBe(true);
  });

  it("keeps an inline quote the sender is answering", () => {
    /* A `>` in the MIDDLE of fresh text is the customer quoting a phrase to respond to
       it. That is their words, not ours, and cutting there would lose their answer. */
    const s = stripQuoted("> you said 50\nNo — 20. And annual, not monthly.");
    expect(s.text).toContain("No — 20");
    expect(s.text).toContain("annual");
  });

  it("returns the whole body when there is no quote", () => {
    const s = stripQuoted("I need 20 users of Business Standard.");
    expect(s.text).toBe("I need 20 users of Business Standard.");
    expect(s.removedQuote).toBe(false);
    expect(s.marker).toBeNull();
  });

  it("returns EMPTY rather than the full text when nothing new was written", () => {
    /* A bare "top-post nothing" reply. The tempting fallback — "if it looks empty use
       the original" — would hand the quoted thread to the extractor in precisely the
       case where the parse is least trustworthy. Empty means nothing-to-do. */
    const s = stripQuoted("On Mon, 1 Jan 2026, a@b.in wrote:\n> 50 users of Starter");
    expect(s.text).toBe("");
    expect(s.removedQuote).toBe(true);
  });

  it("survives null, undefined and whitespace", () => {
    for (const v of [null, undefined, "", "   \n\t "]) {
      const s = stripQuoted(v);
      expect(s.text, String(v)).toBe("");
      expect(s.removedQuote).toBe(false);
    }
  });

  it("normalises CRLF, which is what actually arrives", () => {
    /* The real rows carry \r\n — the fixture in the database reads
       "Hi,\r\n\r\nActually, I need...". A marker regex anchored with $ fails on \r
       unless this is normalised first. */
    const s = stripQuoted("Make it 20.\r\n\r\nOn Sat, 22 Aug 2026 at 21:54, <a@b.in> wrote:\r\n> 50 users");
    expect(s.text).toBe("Make it 20.");
    expect(s.removedQuote).toBe(true);
  });

  it("tolerates a Gmail header wrapped across two lines", () => {
    const s = stripQuoted("Twenty.\n\nOn Sat, 22 Aug 2026 at 21:54,\n<sales@anutech.in> wrote:\n> 50 users");
    expect(s.text).toBe("Twenty.");
  });

  it("names the marker that cut it, for diagnosing a bad strip", () => {
    const s = stripQuoted(REAL_REPLY);
    expect(s.marker).toBeTruthy();
    expect(s.marker!.length).toBeGreaterThan(3);
  });
});
